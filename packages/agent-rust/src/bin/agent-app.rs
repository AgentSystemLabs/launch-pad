//! Launch Pad APP-node agent: the Docker reconciler. Mirrors the app half of
//! `packages/agent/src/index.ts`.
//!
//! Synchronous main thread; async AWS calls are driven via `Handle::block_on` at the
//! I/O leaves (sequential, never nested), so the tested pure planners + the sync
//! `Reconciler` apply path run unchanged in production. Docker/health/IMDS are
//! synchronous (subprocess / ureq).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use launch_pad_agent::aws::{
    cloudwatch_logs_client, ecr_client, load_sdk_config, s3_client, sqs_client, ssm_client,
};
use launch_pad_agent::backup::{
    backup_object_key, backup_state_key, backup_timestamp, database_targets, is_valid_identifier,
    select_expired_keys,
};
use launch_pad_agent::cloudwatch_logs::DirectCloudWatchLogsSync;
use launch_pad_agent::config::{load_agent_config, AgentConfig};
use launch_pad_agent::docker::{self, ManagedReplica, RunSpec};
use launch_pad_agent::ecr::ensure_ecr_login;
use launch_pad_agent::health;
use launch_pad_agent::metadata::resolve_advertise_ip;
use launch_pad_agent::reconcile::{apply_actions, plan_reconcile, CronPlanContext, Reconciler};
use launch_pad_agent::runtime::{
    assert_role, env_i64, install_term_flag, load_agent_env, now_iso, now_millis, run_poll_loop,
    wait_or_wake,
};
use launch_pad_agent::sqs::run_sqs_listener;
use launch_pad_agent::s3::{get_desired, put_status, put_upstream_shard};
use launch_pad_agent::s3_backup::{delete_backup_object, list_backup_keys, put_backup_object};
use launch_pad_agent::secrets::resolve_service_env;
use launch_pad_agent::state::{
    allocate_port, load_state, release_port, save_state, state_path, LocalState,
};
use launch_pad_agent::stats::{
    cpu_shares_by_key, StatsDeps, StatsSampler, SvcCpu, STATS_DEFAULT_INTERVAL_MS,
};
use launch_pad_agent::status::{build_status, heartbeat_status, iso_from_ms, no_caddy};
use launch_pad_agent::status_write::{
    decide_status_write, fingerprint_shard, fingerprint_status, WriteReason, WriteTracker,
};
use launch_pad_agent::types::{
    service_config_stamp, service_key, DatabaseBackupEntry, DatabaseBackupStatus, DesiredState,
    HealthCheck, NodeRole, NodeStatus, ServiceConfig, DEFAULT_POLL_INTERVAL_MS, PROTOCOL_VERSION,
};
use launch_pad_agent::cron::{next_cron_fire, parse_cron_expression};
use launch_pad_agent::upstream::build_upstream_shards;

use tokio::runtime::Handle;

/// Floor on a rollout's drain wait for services fronted by the (remote) edge node.
/// Removing a draining replica from routing is asynchronous: this agent PUTs the
/// upstream shard, the edge sees it on its next poll (DEFAULT_POLL_INTERVAL_MS), then
/// reloads Caddy. Stopping the old container before that lands would 502 every request
/// still routed to it — so the drain must outlast one full edge poll plus S3/reload
/// latency. 1.5× the default poll covers it. Mirrors TS `REMOTE_EDGE_DRAIN_FLOOR_MS`.
const REMOTE_EDGE_DRAIN_FLOOR_MS: i64 = DEFAULT_POLL_INTERVAL_MS + DEFAULT_POLL_INTERVAL_MS / 2;

/// Real stats-sampler I/O: /proc files + `docker stats` + managed-container inspect.
struct AppStatsDeps;

impl StatsDeps for AppStatsDeps {
    fn read(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    }
    fn sleep_ms(&self, ms: i64) {
        std::thread::sleep(Duration::from_millis(ms.max(0) as u64));
    }
    fn docker_stats(&self, ids: &[String]) -> Result<String, String> {
        let mut args: Vec<&str> = vec![
            "stats",
            "--no-stream",
            "--no-trunc",
            "--format",
            "{{json .}}",
        ];
        for id in ids {
            args.push(id);
        }
        let out = std::process::Command::new("docker")
            .args(&args)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "docker stats: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }
    fn inspect(&self) -> Result<Vec<ManagedReplica>, String> {
        Ok(docker::inspect_managed()?.into_values().flatten().collect())
    }
    fn now(&self) -> String {
        now_iso()
    }
}

/// The long-lived agent: owns persistent caches + per-tick state, and implements the
/// `Reconciler` trait so the shared `apply_actions`/`rollout_service` drive real I/O.
struct AppAgent {
    handle: Handle,
    s3: aws_sdk_s3::Client,
    ecr: aws_sdk_ecr::Client,
    ssm: aws_sdk_ssm::Client,
    config: AgentConfig,
    agent_version: String,
    debug_s3: bool,
    state_path: String,

    state: LocalState,
    write_tracker: WriteTracker,
    liveness_ms: i64,
    last_login_ms: Option<i64>,
    last_shard_fps: BTreeMap<String, String>,
    stats: StatsSampler<AppStatsDeps>,
    cloudwatch: DirectCloudWatchLogsSync,
    /// Per-database-service backup rollup, keyed by `project/service`. Updated ONLY on
    /// a backup run (never every tick), so it doesn't churn the write-on-change
    /// fingerprint. In-memory across ticks (re-populated by the next run after a
    /// restart) — telemetry, not convergence state.
    backups: BTreeMap<String, DatabaseBackupStatus>,

    // per-tick state (reset each tick)
    desired: DesiredState,
    errors: BTreeMap<String, String>,
    has_web: bool,
}

impl AppAgent {
    fn put_status_now(&self, status: &NodeStatus) -> Result<(), String> {
        let h = self.handle.clone();
        h.block_on(put_status(
            &self.s3,
            &self.config.bucket,
            &self.config.cluster_id,
            status,
        ))
    }

    /// The tracker is only advanced on a SUCCESSFUL PUT — a failed write must retry
    /// as "changed" on the very next tick, not wait out the liveness interval.
    fn write_status_maybe(
        &mut self,
        status: &NodeStatus,
        now_ms: i64,
    ) -> Result<WriteReason, String> {
        let fp = fingerprint_status(status);
        let decision = decide_status_write(&self.write_tracker, &fp, now_ms, self.liveness_ms);
        if decision.write {
            self.put_status_now(status)?;
            self.write_tracker.fingerprint = Some(fp);
            self.write_tracker.last_write_ms = now_ms;
        }
        Ok(decision.reason)
    }

    /// Best-effort unconditional PUT (mid-rollout heartbeat / error path); the
    /// tracker is only advanced on success so a failure retries next tick.
    fn write_status_forced(&mut self, status: &NodeStatus, now_ms: i64) {
        match self.put_status_now(status) {
            Ok(()) => {
                self.write_tracker.fingerprint = Some(fingerprint_status(status));
                self.write_tracker.last_write_ms = now_ms;
            }
            Err(e) => eprintln!("[agent] s3 put status: {e}"),
        }
    }

    fn current_status(&mut self) -> Result<NodeStatus, String> {
        let live = docker::inspect_managed()?;
        Ok(build_status(
            &self.config,
            &self.agent_version,
            &self.desired,
            &live,
            &self.errors,
            &self.backups,
            &no_caddy(),
            self.stats.latest_host(),
            &now_iso(),
            now_millis(),
        ))
    }

    /// Publish this node's upstream shards (routing for the edge). `exclude_ids`
    /// drops replicas that are draining mid-rollout, so the edge stops routing to
    /// them BEFORE they are stopped. Write-on-change per edge.
    fn publish_upstream(&mut self, exclude_ids: &BTreeSet<String>) -> Result<(), String> {
        let live = docker::inspect_managed()?;
        let private_ip = resolve_advertise_ip(self.config.advertise_ip.as_deref())?;
        let now = now_iso();
        let shards = build_upstream_shards(
            &self.config.node_id,
            &private_ip,
            &self.desired,
            &live,
            exclude_ids,
            &now,
        );
        for (edge_id, shard) in shards {
            let fp = fingerprint_shard(&shard);
            if self.last_shard_fps.get(&edge_id) == Some(&fp) {
                if self.debug_s3 {
                    eprintln!("[agent] s3: upstream {edge_id} skip");
                }
                continue;
            }
            let h = self.handle.clone();
            h.block_on(put_upstream_shard(
                &self.s3,
                &self.config.bucket,
                &self.config.cluster_id,
                &edge_id,
                &self.config.node_id,
                &shard,
            ))?;
            self.last_shard_fps.insert(edge_id.clone(), fp);
            if self.debug_s3 {
                eprintln!("[agent] s3: upstream {edge_id} PUT");
            }
        }
        Ok(())
    }

    fn sync_cloudwatch(&mut self) {
        match docker::inspect_managed() {
            Ok(map) => {
                let live: Vec<ManagedReplica> = map.into_values().flatten().collect();
                let h = self.handle.clone();
                h.block_on(self.cloudwatch.sync(&live, now_millis()));
            }
            Err(e) => eprintln!("[agent] cloudwatch: {e}"),
        }
    }

    fn tick(&mut self) {
        if let Err(msg) = self.tick_inner() {
            eprintln!("[agent] reconcile error: {msg}");
            let status = heartbeat_status(&self.config, &self.agent_version, &msg, &now_iso());
            self.write_status_forced(&status, now_millis());
        }
    }

    fn tick_inner(&mut self) -> Result<(), String> {
        self.errors.clear();

        let now = now_iso();
        let desired = {
            let h = self.handle.clone();
            h.block_on(get_desired(
                &self.s3,
                &self.config.bucket,
                &self.config.cluster_id,
                &self.config.node_id,
                &now,
            ))?
        };
        self.desired = desired;

        if !self.desired.services.is_empty() {
            let h = self.handle.clone();
            h.block_on(ensure_ecr_login(
                &self.ecr,
                &mut self.last_login_ms,
                now_millis(),
                false,
            ))?;
        }

        // Any web service here is fronted by the cluster's dedicated edge: its routing
        // lives in the S3 upstream shard this node publishes. App nodes never run Caddy.
        self.has_web = self.desired.services.iter().any(|s| s.ingress.is_some());

        let live = docker::inspect_managed()?;

        // Cron bookkeeping: seed a first-sight anchor for new schedules (so they
        // start counting from NOW, not from history) and drop state for keys that
        // are no longer scheduled. The same anchor map (`cron_fires`) also holds the
        // backup-namespaced anchors (`backup:<key>`) for managed databases — both are
        // seeded at NOW on first sight and pruned when their service goes away.
        let cron_keys: BTreeSet<String> = self
            .desired
            .services
            .iter()
            .filter(|s| s.cron.is_some())
            .map(|s| format!("{}/{}", s.project, s.service))
            .collect();
        // Backup anchor keys for managed databases with a backup schedule.
        let backup_keys: BTreeSet<String> = self
            .desired
            .services
            .iter()
            .filter(|s| s.backup.is_some())
            .map(|s| backup_state_key(&service_key(&s.project, &s.service)))
            .collect();
        let mut cron_state_dirty = false;
        for key in &cron_keys {
            if !self.state.cron_fires.contains_key(key) {
                // Respect a RUNNING run container's fire label if one survives in docker
                // (state.json lost mid-run) — otherwise anchor at now. An EXITED
                // container's label is deliberately ignored here: it could be a stale
                // leftover from a previous footprint life and trusting it would fire a
                // catch-up run.
                let label_fire = live
                    .get(key)
                    .map(|reps| {
                        reps.iter()
                            .filter(|r| r.state == "running")
                            .fold(0, |m, r| m.max(r.cron_fire_ms.unwrap_or(0)))
                    })
                    .unwrap_or(0);
                let anchor = if label_fire > 0 {
                    label_fire
                } else {
                    now_millis()
                };
                self.state.cron_fires.insert(key.clone(), anchor);
                cron_state_dirty = true;
            }
        }
        // Seed a first-sight backup anchor at NOW (no container fire labels for
        // backups — the dump is an in-container exec, not a cron run container).
        for key in &backup_keys {
            if !self.state.cron_fires.contains_key(key) {
                self.state.cron_fires.insert(key.clone(), now_millis());
                cron_state_dirty = true;
            }
        }
        // Prune anchors whose service is gone — but NEVER a still-live backup anchor
        // (it is not in `cron_keys`).
        let stale_keys: Vec<String> = self
            .state
            .cron_fires
            .keys()
            .filter(|k| !cron_keys.contains(*k) && !backup_keys.contains(*k))
            .cloned()
            .collect();
        for key in stale_keys {
            self.state.cron_fires.remove(&key);
            cron_state_dirty = true;
        }
        if cron_state_dirty {
            save_state(&self.state_path, &self.state);
        }

        let cron_ctx = CronPlanContext {
            now_ms: now_millis(),
            last_fires: self.state.cron_fires.clone(),
        };
        let actions = plan_reconcile(&self.desired, &live, Some(&cron_ctx));
        apply_actions(&actions, self);

        // Re-publish the S3 shards the edge consumes. Rollouts already published at
        // every surge/drain step — this is the tick-end refresh.
        if self.has_web {
            self.publish_upstream(&BTreeSet::new())?;
        }

        // Sample host + per-container usage BEFORE the status write, so the freshest
        // host sample rides this tick's PUT (status.json embeds it for autoscale).
        let shares = cpu_shares_by_key(
            &self
                .desired
                .services
                .iter()
                .map(|s| SvcCpu {
                    project: s.project.clone(),
                    service: s.service.clone(),
                    cpu: s.cpu,
                })
                .collect::<Vec<_>>(),
        );
        self.stats.maybe_sample(now_millis(), &shares);

        let status = self.current_status()?;
        let reason = self.write_status_maybe(&status, now_millis())?;
        if self.debug_s3 {
            eprintln!("[agent] s3: status {reason:?}");
        }

        // Reconcile CloudWatch log shipping to the containers now running on this node.
        self.sync_cloudwatch();
        Ok(())
    }
}

impl Reconciler for AppAgent {
    fn pull(&mut self, image: &str) -> Result<(), String> {
        docker::pull(image)
    }
    fn run_container(
        &mut self,
        config: &ServiceConfig,
        index: i64,
        host_port: Option<i64>,
        bind_host: &str,
        cron_fire_ms: Option<i64>,
    ) -> Result<(), String> {
        // Secrets are resolved at container start (never cached) and the config stamp
        // is computed from the same desired config — mirrors TS `runContainer`.
        let merged_env = {
            let h = self.handle.clone();
            h.block_on(resolve_service_env(&self.ssm, config))?
        };
        let stamp = service_config_stamp(config);
        let spec = RunSpec {
            config,
            index,
            host_port,
            bind_host,
            cron_fire_ms,
        };
        docker::run_container(&spec, &merged_env, &stamp)
    }
    fn start_container(&mut self, id: &str) -> Result<(), String> {
        docker::start_container(id)
    }
    fn stop_container(&mut self, name_or_id: &str, grace_seconds: i64) -> Result<(), String> {
        docker::stop_container(name_or_id, grace_seconds)
    }
    fn remove_container(&mut self, id: &str) -> Result<(), String> {
        docker::remove_container(id)
    }
    fn bind_host(&self, config: &ServiceConfig) -> String {
        // Web replicas bind 0.0.0.0 so the edge can dial them over the VPC; workers
        // expose nothing and stay loopback-only.
        if config.ingress.is_some() {
            "0.0.0.0".to_string()
        } else {
            "127.0.0.1".to_string()
        }
    }
    fn allocate_port(&mut self, key: &str, index: i64) -> i64 {
        let port = allocate_port(&mut self.state, key, index);
        save_state(&self.state_path, &self.state);
        port
    }
    fn release_port(&mut self, key: &str, index: i64) {
        release_port(&mut self.state, key, index);
        save_state(&self.state_path, &self.state);
    }
    fn refresh_routing(&mut self, exclude_ids: &BTreeSet<String>) -> Result<(), String> {
        if !self.has_web {
            return Ok(());
        }
        // Propagated on purpose: a rollout must ABORT (not proceed to stop a
        // still-routed replica) when the shard publish fails.
        self.publish_upstream(exclude_ids)
    }
    fn drain_floor_ms(&self, config: &ServiceConfig) -> i64 {
        if config.ingress.is_some() {
            REMOTE_EDGE_DRAIN_FLOOR_MS
        } else {
            0
        }
    }
    fn heartbeat(&mut self) {
        match self.current_status() {
            Ok(status) => {
                self.write_status_forced(&status, now_millis());
                if self.debug_s3 {
                    eprintln!("[agent] s3: status PUT (rollout heartbeat)");
                }
            }
            Err(e) => eprintln!("[agent] heartbeat: {e}"),
        }
    }
    fn sleep_ms(&mut self, ms: i64) {
        std::thread::sleep(Duration::from_millis(ms.max(0) as u64));
    }
    fn wait_healthy(&mut self, host_port: i64, hc: &HealthCheck, ceiling_ms: i64) -> bool {
        health::wait_healthy(
            hc,
            ceiling_ms,
            || health::probe_health(host_port, &hc.path, hc.timeout_ms),
            now_millis,
            |ms| std::thread::sleep(Duration::from_millis(ms.max(0) as u64)),
        )
    }
    fn record_cron_fire(&mut self, key: &str, fire_ms: i64) -> Result<(), String> {
        let previous = self.state.cron_fires.insert(key.to_string(), fire_ms);
        // The skip-not-duplicate guarantee requires the fire to be durable BEFORE the
        // run starts — refuse to run when it can't be persisted (the per-action error
        // isolation surfaces this in the service status). Roll the in-memory record
        // back too, so the same fire retries once the disk recovers instead of
        // silently waiting for the next schedule boundary.
        if !save_state(&self.state_path, &self.state) {
            match previous {
                Some(prev) => {
                    self.state.cron_fires.insert(key.to_string(), prev);
                }
                None => {
                    self.state.cron_fires.remove(key);
                }
            }
            return Err(
                "could not persist the cron fire record — refusing to start the run".into(),
            );
        }
        Ok(())
    }
    fn set_error(&mut self, key: &str, message: String) {
        self.errors.insert(key.to_string(), message);
    }
    fn run_backup(&mut self, config: &ServiceConfig, fire_ms: i64) -> Result<(), String> {
        let key = service_key(&config.project, &config.service);
        let outcome = self.perform_backup(config, fire_ms);

        // Record the fire AFTER the attempt: a DB-up attempt advances the anchor even
        // if a per-db dump failed (the failure surfaces in status.lastError, not as a
        // replayed fire). A failure to PERSIST the fire is the one case we surface as a
        // service error — otherwise the same fire would re-run next tick.
        let record = self.record_cron_fire(&backup_state_key(&key), fire_ms);

        self.backups.insert(key.clone(), outcome.status);
        if let Some(err) = outcome.first_error {
            self.set_error(&key, err);
        }
        record
    }
}

/// What one backup pass produced: the rollup status plus the first per-db error (if
/// any) to surface on the service.
struct BackupOutcome {
    status: DatabaseBackupStatus,
    first_error: Option<String>,
}

impl AppAgent {
    /// Run the dump/upload/prune for one managed database service. Per-database
    /// failures are folded into the returned status (never thrown) so the fire still
    /// advances; only an env/enumeration setup failure leaves every db unattempted.
    fn perform_backup(&mut self, config: &ServiceConfig, fire_ms: i64) -> BackupOutcome {
        let Some(backup) = config.backup.clone() else {
            // Unreachable: the planner only emits BackupRun for a service with backup.
            return BackupOutcome {
                status: empty_backup_status(fire_ms, None),
                first_error: None,
            };
        };
        let now_ms = now_millis();
        // The object timestamp is anchored to the SCHEDULED fire boundary, not wall-clock
        // now: a crash before the fire is persisted re-runs the same fire, and using
        // `fire_ms` makes that retry OVERWRITE the same S3 key instead of creating a
        // duplicate dump. `now_ms` is still used for `last_success_at` and the prune cutoff.
        let timestamp = backup_timestamp(fire_ms);
        let next_run_at = parse_cron_expression(&backup.schedule)
            .ok()
            .and_then(|s| next_cron_fire(&s, now_ms))
            .and_then(iso_from_ms);

        // Resolve env/secrets to get the DB password (+ optional user). A failure here
        // means we can't dump anything this run.
        let merged_env = {
            let h = self.handle.clone();
            match h.block_on(resolve_service_env(&self.ssm, config)) {
                Ok(env) => env,
                Err(e) => {
                    let err = format!("backup: resolve env: {e}");
                    return BackupOutcome {
                        status: DatabaseBackupStatus {
                            last_run_at: iso_from_ms(fire_ms),
                            last_success_at: None,
                            last_error: Some(err.clone()),
                            next_run_at,
                            databases: vec![],
                        },
                        first_error: Some(err),
                    };
                }
            }
        };
        let pg_user = merged_env
            .get("POSTGRES_USER")
            .cloned()
            .unwrap_or_else(|| "postgres".to_string());
        // The user is interpolated into the `pg_dump`/`psql` invocation — refuse a
        // malformed value rather than passing it to the engine, and fail the WHOLE run
        // (a bad user breaks every db).
        if !is_valid_identifier(&pg_user) {
            let err = "backup: invalid POSTGRES_USER".to_string();
            return BackupOutcome {
                status: DatabaseBackupStatus {
                    last_run_at: iso_from_ms(fire_ms),
                    last_success_at: None,
                    last_error: Some(err.clone()),
                    next_run_at,
                    databases: vec![],
                },
                first_error: Some(err),
            };
        }
        let pg_password = merged_env.get("POSTGRES_PASSWORD").cloned().unwrap_or_default();
        // Refuse to exec with a blank password — a dump that succeeds against a
        // trust-auth misconfiguration would silently bypass the intended credential.
        if pg_password.is_empty() {
            let err = "backup: POSTGRES_PASSWORD unset".to_string();
            return BackupOutcome {
                status: DatabaseBackupStatus {
                    last_run_at: iso_from_ms(fire_ms),
                    last_success_at: None,
                    last_error: Some(err.clone()),
                    next_run_at,
                    databases: vec![],
                },
                first_error: Some(err),
            };
        }
        let exec_env = vec![("PGPASSWORD".to_string(), pg_password)];

        // The DB container the planner already gated on as running.
        let container = match self.running_db_container(&config.project, &config.service) {
            Some(c) => c,
            None => {
                let err = "backup: no running database container".to_string();
                return BackupOutcome {
                    status: DatabaseBackupStatus {
                        last_run_at: iso_from_ms(fire_ms),
                        last_success_at: None,
                        last_error: Some(err.clone()),
                        next_run_at,
                        databases: vec![],
                    },
                    first_error: Some(err),
                };
            }
        };

        // Determine targets: explicit list, else enumerate every non-template db.
        let explicit = config
            .database
            .as_ref()
            .map(|d| d.databases.clone())
            .unwrap_or_default();
        let enumerated = if explicit.is_empty() {
            match self.enumerate_databases(&container, &pg_user, &exec_env) {
                Ok(dbs) => dbs,
                Err(e) => {
                    let err = format!("backup: enumerate databases: {e}");
                    return BackupOutcome {
                        status: DatabaseBackupStatus {
                            last_run_at: iso_from_ms(fire_ms),
                            last_success_at: None,
                            last_error: Some(err.clone()),
                            next_run_at,
                            databases: vec![],
                        },
                        first_error: Some(err),
                    };
                }
            }
        } else {
            Vec::new()
        };
        let targets = database_targets(&explicit, &enumerated);

        let mut entries: Vec<DatabaseBackupEntry> = Vec::new();
        let mut first_error: Option<String> = None;
        let mut all_ok = true;

        for db in &targets {
            // A multi-database backup is fully synchronous and can be long: write a
            // liveness heartbeat at the top of each db so the node doesn't look dead to
            // the CLI/autoscale while a large dump is in flight. Best-effort — a failed
            // heartbeat must not abort the backup (mirrors rollout_service).
            self.heartbeat();

            // Validate the target name before it is interpolated into the dump command
            // AND the S3 object key — an un-sanitized enumerated name (e.g. containing
            // `/` or `..`) could escape the backup prefix. Skip + record a per-db error.
            if !is_valid_identifier(db) {
                all_ok = false;
                if first_error.is_none() {
                    first_error = Some(format!("backup {db}: invalid database name"));
                }
                entries.push(DatabaseBackupEntry {
                    name: db.clone(),
                    last_success_at: None,
                    size_bytes: None,
                });
                continue;
            }
            match self.dump_and_upload(&container, db, &pg_user, &exec_env, &backup, &timestamp) {
                Ok(size) => {
                    entries.push(DatabaseBackupEntry {
                        name: db.clone(),
                        last_success_at: iso_from_ms(now_ms),
                        size_bytes: Some(size),
                    });
                }
                Err(e) => {
                    all_ok = false;
                    if first_error.is_none() {
                        first_error = Some(format!("backup {db}: {e}"));
                    }
                    entries.push(DatabaseBackupEntry {
                        name: db.clone(),
                        last_success_at: None,
                        size_bytes: None,
                    });
                }
            }
            // Prune expired dumps for this db (best-effort — a prune failure doesn't
            // fail the backup, but is surfaced as the first error if none yet).
            if let Err(e) = self.prune_database(db, &backup, now_ms) {
                if first_error.is_none() {
                    first_error = Some(format!("backup prune {db}: {e}"));
                }
            }
        }

        let last_success_at = if all_ok && !targets.is_empty() {
            iso_from_ms(now_ms)
        } else {
            None
        };

        BackupOutcome {
            status: DatabaseBackupStatus {
                last_run_at: iso_from_ms(fire_ms),
                last_success_at,
                last_error: first_error.clone(),
                next_run_at,
                databases: entries,
            },
            first_error,
        }
    }

    /// The name of a running container for this database service, if any.
    fn running_db_container(&self, project: &str, service: &str) -> Option<String> {
        let live = docker::inspect_managed().ok()?;
        let key = service_key(project, service);
        live.get(&key)?
            .iter()
            .find(|r| r.state == "running")
            .map(|r| r.name.clone())
    }

    /// Enumerate every non-template, non-`postgres` logical database in the engine.
    fn enumerate_databases(
        &self,
        container: &str,
        pg_user: &str,
        exec_env: &[(String, String)],
    ) -> Result<Vec<String>, String> {
        let cmd = vec![
            "psql",
            "-U",
            pg_user,
            "-At",
            "-c",
            "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'",
        ];
        let out = docker::exec_capture(container, exec_env, &cmd)?;
        let text = String::from_utf8_lossy(&out);
        // Drop any name that is not a safe identifier: it can't be a database we'd
        // back up (the name escapes the S3 prefix), so it is never a managed target.
        Ok(text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && is_valid_identifier(l))
            .map(|l| l.to_string())
            .collect())
    }

    /// Dump one database to a temp file, upload it to S3, then delete the temp file.
    /// Returns the uploaded size in bytes.
    fn dump_and_upload(
        &self,
        container: &str,
        db: &str,
        pg_user: &str,
        exec_env: &[(String, String)],
        backup: &launch_pad_agent::types::ServiceBackupConfig,
        timestamp: &str,
    ) -> Result<i64, String> {
        use std::os::unix::fs::DirBuilderExt;
        let work_dir = backup_work_dir();
        // The dir holds plaintext-equivalent DB dumps — create it 0700 so only the
        // agent's user can list/read its contents.
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&work_dir)
            .map_err(|e| format!("create {}: {e}", work_dir.display()))?;
        let tmp = work_dir.join(format!(
            "{}_{}_{}_{timestamp}.sql.gz",
            config_safe(&self.config.node_id),
            config_safe(db),
            now_millis()
        ));

        // `pg_dump -Z 6` emits a gzip-compressed plain SQL dump straight to stdout — no
        // shell pipe to `gzip`. This (a) removes the shell entirely so `pg_user`/`db`
        // are discrete argv elements with no injection surface, and (b) makes the child
        // exit code pg_dump's REAL exit: the old `pg_dump | gzip` pipe masked a pg_dump
        // failure behind gzip's success, uploading an empty "successful" backup.
        let cmd = vec![
            "pg_dump",
            "-U",
            pg_user,
            "-d",
            db,
            "-Z",
            "6",
        ];
        let result = (|| -> Result<i64, String> {
            docker::exec_to_file(container, exec_env, &cmd, &tmp)?;
            // A real dump is never empty (pg_dump always writes a header). A zero-byte
            // file means the dump produced nothing — treat it as a failure rather than
            // uploading an empty backup.
            let size = std::fs::metadata(&tmp)
                .map(|m| m.len() as i64)
                .map_err(|e| format!("stat dump: {e}"))?;
            if size == 0 {
                return Err("dump produced an empty file".to_string());
            }
            let key = backup_object_key(&backup.prefix, db, timestamp);
            let h = self.handle.clone();
            h.block_on(put_backup_object(&self.s3, &backup.bucket, &key, &tmp))?;
            // Clamp to JS Number.MAX_SAFE_INTEGER: the CLI parses status.json with a
            // strict `z.number().int()`, so an i64 beyond 2^53 would lose precision (and
            // a strict zod upper bound would wedge parsing). Defensive — practically
            // unreachable for a single dump.
            Ok(size.min(9_007_199_254_740_991))
        })();
        // Always clean up the temp file, success or failure.
        let _ = std::fs::remove_file(&tmp);
        result
    }

    /// Prune dumps older than `retentionDays` under this database's prefix.
    fn prune_database(
        &self,
        db: &str,
        backup: &launch_pad_agent::types::ServiceBackupConfig,
        now_ms: i64,
    ) -> Result<(), String> {
        let prefix = format!("{}{db}/", backup.prefix);
        let h = self.handle.clone();
        let keys = h.block_on(list_backup_keys(&self.s3, &backup.bucket, &prefix))?;
        let expired = select_expired_keys(&keys, now_ms, backup.retention_days);
        for key in expired {
            let h = self.handle.clone();
            h.block_on(delete_backup_object(&self.s3, &backup.bucket, &key))?;
        }
        Ok(())
    }
}

/// Backup status with no databases — used for the unreachable no-backup-config path.
fn empty_backup_status(fire_ms: i64, error: Option<String>) -> DatabaseBackupStatus {
    DatabaseBackupStatus {
        last_run_at: iso_from_ms(fire_ms),
        last_success_at: None,
        last_error: error,
        next_run_at: None,
        databases: vec![],
    }
}

/// The node-local working directory for transient dump files (env-overridable).
fn backup_work_dir() -> std::path::PathBuf {
    std::env::var("LAUNCHPAD_BACKUP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/var/lib/launch-pad/backups"))
}

/// Sanitize a string for use inside a temp filename (alnum + hyphen kept, rest `_`).
fn config_safe(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

/// Fail closed, loudly, when Docker isn't available — an app node without Docker is a
/// provisioning error (wrong AMI for the role?). systemd restarts the agent, so this
/// retries until Docker comes up (cloud-init ordering) or the operator intervenes.
fn assert_docker_available() {
    let ok = std::process::Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        eprintln!(
            "[agent] fatal: docker is not available on this app node. If this node was \
             provisioned from the EDGE golden AMI, re-create it with role=app (the app AMI \
             ships Docker); if Docker is still starting, this will retry via systemd."
        );
        std::process::exit(1);
    }
}

fn main() {
    let config = match load_agent_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[agent] config: {e}");
            std::process::exit(1);
        }
    };
    assert_role(&config, NodeRole::App, "launchpad-agent-app");
    assert_docker_available();

    let env = load_agent_env();
    for w in &env.liveness.warnings {
        eprintln!("[agent] liveness: {w}");
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    let sdk = rt.block_on(load_sdk_config(&config.region));

    let state_path = state_path();
    let state = load_state(&state_path);

    let stats = StatsSampler::new(
        config.node_id.clone(),
        env_i64("LAUNCHPAD_STATS_INTERVAL_MS", STATS_DEFAULT_INTERVAL_MS),
        std::env::var("LAUNCHPAD_STATS_SERVICES").as_deref() != Ok("0"),
        AppStatsDeps,
        |line: &str| eprintln!("{line}"),
        |m: &str| eprintln!("[agent] stats: {m}"),
    );

    let cloudwatch = DirectCloudWatchLogsSync::new(
        config.cluster_id.clone(),
        config.node_id.clone(),
        config.role,
        cloudwatch_logs_client(&sdk),
        |m: &str| eprintln!("{m}"),
    );

    eprintln!(
        "[agent] starting app agent for node {} (bucket {}) poll={}ms liveness={}ms",
        config.node_id, config.bucket, env.interval_ms, env.liveness.liveness_ms
    );

    // Capture ids for the SNS→SQS listener before `config` moves into the agent.
    let sqs = sqs_client(&sdk);
    let listener_cluster = config.cluster_id.clone();
    let listener_node = config.node_id.clone();

    let mut agent = AppAgent {
        handle: rt.handle().clone(),
        s3: s3_client(&sdk),
        ecr: ecr_client(&sdk),
        ssm: ssm_client(&sdk),
        config,
        agent_version: env.agent_version.clone(),
        debug_s3: env.debug_s3,
        state_path,
        state,
        write_tracker: WriteTracker {
            fingerprint: None,
            last_write_ms: 0,
        },
        liveness_ms: env.liveness.liveness_ms,
        last_login_ms: None,
        last_shard_fps: BTreeMap::new(),
        stats,
        cloudwatch,
        backups: BTreeMap::new(),
        desired: DesiredState {
            version: PROTOCOL_VERSION,
            node_id: String::new(),
            updated_at: String::new(),
            services: Vec::new(),
        },
        errors: BTreeMap::new(),
        has_web: false,
    };

    let term = install_term_flag();

    // Push half of the hybrid model: a background task long-polls this node's SQS queue
    // for SNS deploy notifications and wakes the reconcile loop the instant one lands.
    // Polling (env.interval_ms) stays the fallback when no notification arrives.
    let notify = Arc::new(tokio::sync::Notify::new());
    if !env.once {
        let notify = Arc::clone(&notify);
        let term = Arc::clone(&term);
        rt.spawn(run_sqs_listener(sqs, listener_cluster, listener_node, notify, term));
    }
    let handle = rt.handle().clone();
    run_poll_loop(
        env.interval_ms,
        env.once,
        &term,
        |d| wait_or_wake(&handle, &notify, &term, d),
        || agent.tick(),
    );
}
