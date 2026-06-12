//! Launch Pad APP-node agent: the Docker reconciler. Mirrors the app half of
//! `packages/agent/src/index.ts`.
//!
//! Synchronous main thread; async AWS calls are driven via `Handle::block_on` at the
//! I/O leaves (sequential, never nested), so the tested pure planners + the sync
//! `Reconciler` apply path run unchanged in production. Docker/health/IMDS are
//! synchronous (subprocess / ureq).

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use launch_pad_agent::aws::{ecr_client, load_sdk_config, s3_client, ssm_client};
use launch_pad_agent::cloudwatch_logs::CloudWatchAgentSync;
use launch_pad_agent::config::{load_agent_config, AgentConfig};
use launch_pad_agent::docker::{self, ManagedReplica, RunSpec};
use launch_pad_agent::ecr::ensure_ecr_login;
use launch_pad_agent::health;
use launch_pad_agent::metadata::get_private_ip;
use launch_pad_agent::reconcile::{apply_actions, plan_reconcile, CronPlanContext, Reconciler};
use launch_pad_agent::runtime::{
    assert_role, env_i64, install_term_flag, load_agent_env, now_iso, now_millis, run_poll_loop,
};
use launch_pad_agent::s3::{get_desired, put_status, put_upstream_shard};
use launch_pad_agent::secrets::resolve_service_env;
use launch_pad_agent::state::{
    allocate_port, load_state, release_port, save_state, state_path, LocalState,
};
use launch_pad_agent::stats::{
    cpu_shares_by_key, StatsDeps, StatsSampler, SvcCpu, STATS_DEFAULT_INTERVAL_MS,
};
use launch_pad_agent::status::{build_status, heartbeat_status, no_caddy};
use launch_pad_agent::status_write::{
    decide_status_write, fingerprint_shard, fingerprint_status, WriteReason, WriteTracker,
};
use launch_pad_agent::types::{
    service_config_stamp, DesiredState, HealthCheck, NodeRole, NodeStatus, ServiceConfig,
    DEFAULT_POLL_INTERVAL_MS, PROTOCOL_VERSION,
};
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
        let mut args: Vec<&str> = vec!["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"];
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
    cloudwatch: CloudWatchAgentSync,

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
    fn write_status_maybe(&mut self, status: &NodeStatus, now_ms: i64) -> Result<WriteReason, String> {
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
        let private_ip = get_private_ip()?;
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
                self.cloudwatch.sync(&live);
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
            h.block_on(ensure_ecr_login(&self.ecr, &mut self.last_login_ms, now_millis(), false))?;
        }

        // Any web service here is fronted by the cluster's dedicated edge: its routing
        // lives in the S3 upstream shard this node publishes. App nodes never run Caddy.
        self.has_web = self.desired.services.iter().any(|s| s.ingress.is_some());

        let live = docker::inspect_managed()?;

        // Cron bookkeeping: seed a first-sight anchor for new schedules (so they
        // start counting from NOW, not from history) and drop state for keys that
        // are no longer scheduled.
        let cron_keys: BTreeSet<String> = self
            .desired
            .services
            .iter()
            .filter(|s| s.cron.is_some())
            .map(|s| format!("{}/{}", s.project, s.service))
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
                let anchor = if label_fire > 0 { label_fire } else { now_millis() };
                self.state.cron_fires.insert(key.clone(), anchor);
                cron_state_dirty = true;
            }
        }
        let stale_keys: Vec<String> = self
            .state
            .cron_fires
            .keys()
            .filter(|k| !cron_keys.contains(*k))
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
            return Err("could not persist the cron fire record — refusing to start the run".into());
        }
        Ok(())
    }
    fn set_error(&mut self, key: &str, message: String) {
        self.errors.insert(key.to_string(), message);
    }
}

fn cw_reload(config_path: &str) -> Result<(), String> {
    const CW_AGENT_CTL: &str = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl";
    let out = std::process::Command::new(CW_AGENT_CTL)
        .args(["-a", "fetch-config", "-m", "ec2", "-s", "-c", &format!("file:{config_path}")])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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

    let cloudwatch = CloudWatchAgentSync::new(
        config.cluster_id.clone(),
        config.node_id.clone(),
        config.role,
        |path: &str, contents: &str| std::fs::write(path, contents).map_err(|e| e.to_string()),
        cw_reload,
        |m: &str| eprintln!("{m}"),
    );

    eprintln!(
        "[agent] starting app agent for node {} (bucket {}) poll={}ms liveness={}ms",
        config.node_id, config.bucket, env.interval_ms, env.liveness.liveness_ms
    );

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
    run_poll_loop(env.interval_ms, env.once, &term, || agent.tick());
}
