//! Launch Pad node agent (Rust) — the poll loop. Mirrors `packages/agent/src/index.ts`.
//!
//! Synchronous main thread; async AWS calls are driven via `Handle::block_on` at the
//! I/O leaves (sequential, never nested), so the tested pure planners + the sync
//! `Reconciler` apply path run unchanged in production. Docker/Caddy/health/IMDS are
//! synchronous (subprocess / ureq).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use launch_pad_agent::aws::make_clients;
use launch_pad_agent::caddy::{apply_caddy, CaddyOutcome, CaddyState, WebRoute};
use launch_pad_agent::cloudwatch_logs::CloudWatchAgentSync;
use launch_pad_agent::config::{load_agent_config, AgentConfig};
use launch_pad_agent::docker::{self, ManagedReplica};
use launch_pad_agent::ecr::ensure_ecr_login;
use launch_pad_agent::health;
use launch_pad_agent::metadata::get_private_ip;
use launch_pad_agent::reconcile::{apply_actions, plan_reconcile, Reconciler};
use launch_pad_agent::routes::{
    build_co_located_routes, build_shard_routes, is_co_located_ingress, merge_routes_by_domain,
};
use launch_pad_agent::s3::{
    get_desired, list_upstream_shards, put_status, put_upstream_shard, ShardListCache,
};
use launch_pad_agent::state::{
    allocate_port, load_state, release_port, save_state, state_path, LocalState,
};
use launch_pad_agent::stats::{cpu_shares_by_key, StatsDeps, StatsSampler, SvcCpu, STATS_DEFAULT_INTERVAL_MS};
use launch_pad_agent::status::{build_status, heartbeat_status};
use launch_pad_agent::status_write::{
    decide_status_write, fingerprint_shard, fingerprint_status, resolve_liveness, WriteReason,
    WriteTracker,
};
use launch_pad_agent::types::{
    CaddyStatus, DesiredState, EdgeRouteStatus, HealthCheck, NodeRole, NodeStatus, ServiceConfig,
    DEFAULT_POLL_INTERVAL_MS, HEARTBEAT_STALE_MS, LIVENESS_HEARTBEAT_MS,
};
use launch_pad_agent::upstream::build_upstream_shards;

use tokio::runtime::Handle;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn no_caddy() -> CaddyOutcome {
    CaddyOutcome {
        managed: false,
        last_reload_at: None,
        error: None,
    }
}

/// Real stats-sampler I/O: /proc files + `docker stats` + managed-container inspect.
struct AgentStatsDeps;

impl StatsDeps for AgentStatsDeps {
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
struct AgentReconciler {
    handle: Handle,
    s3: aws_sdk_s3::Client,
    ecr: aws_sdk_ecr::Client,
    config: AgentConfig,
    agent_version: String,
    caddy_admin: String,
    debug_s3: bool,
    state_path: String,

    state: LocalState,
    caddy_st: CaddyState,
    write_tracker: WriteTracker,
    liveness_ms: i64,
    last_login_ms: Option<i64>,
    last_shard_fps: BTreeMap<String, String>,
    shard_cache: ShardListCache,
    stats: StatsSampler<AgentStatsDeps>,
    cloudwatch: CloudWatchAgentSync,

    // per-tick state (reset each tick)
    desired: DesiredState,
    errors: BTreeMap<String, String>,
    caddy_outcome: CaddyOutcome,
    has_co_located_web: bool,
    fronts_remote_apps: bool,
}

impl AgentReconciler {
    fn put_status_now(&self, status: &NodeStatus) {
        let h = self.handle.clone();
        if let Err(e) = h.block_on(put_status(
            &self.s3,
            &self.config.bucket,
            &self.config.cluster_id,
            status,
        )) {
            eprintln!("[agent] s3 put status: {e}");
        }
    }

    /// Inline equivalent of `StatusWriter::maybe_write` (uses the tested pure decision).
    fn write_status_maybe(&mut self, status: &NodeStatus, now_ms: i64) -> WriteReason {
        let fp = fingerprint_status(status);
        let decision = decide_status_write(&self.write_tracker, &fp, now_ms, self.liveness_ms);
        if decision.write {
            self.put_status_now(status);
            self.write_tracker.fingerprint = Some(fp);
            self.write_tracker.last_write_ms = now_ms;
        }
        decision.reason
    }

    /// Inline equivalent of `StatusWriter::force_write`.
    fn write_status_forced(&mut self, status: &NodeStatus, now_ms: i64) {
        self.put_status_now(status);
        self.write_tracker.fingerprint = Some(fingerprint_status(status));
        self.write_tracker.last_write_ms = now_ms;
    }

    fn build_caddy_routes(&mut self, exclude_ids: &BTreeSet<String>) -> Result<Vec<WebRoute>, String> {
        let live = docker::inspect_managed()?;
        let mut routes = build_co_located_routes(&self.config.node_id, &self.desired, &live, exclude_ids);
        if self.fronts_remote_apps {
            let h = self.handle.clone();
            let shards = h.block_on(list_upstream_shards(
                &self.s3,
                &self.config.bucket,
                &self.config.cluster_id,
                &self.config.node_id,
                Some(&mut self.shard_cache),
            ))?;
            routes.extend(build_shard_routes(&shards));
        }
        Ok(merge_routes_by_domain(routes))
    }

    fn current_status(&self) -> Result<NodeStatus, String> {
        let live = docker::inspect_managed()?;
        Ok(build_status(
            &self.config,
            &self.agent_version,
            &self.desired,
            &live,
            &self.errors,
            &self.caddy_outcome,
            &now_iso(),
        ))
    }

    fn publish_upstream(&mut self) -> Result<(), String> {
        let live = docker::inspect_managed()?;
        let private_ip = get_private_ip()?;
        let now = now_iso();
        let shards = build_upstream_shards(&self.config.node_id, &private_ip, &self.desired, &live, &now);
        for (edge_id, shard) in shards {
            if edge_id == self.config.node_id {
                continue;
            }
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

    fn sync_cloudwatch(&mut self, replicas: &[ManagedReplica]) {
        self.cloudwatch.sync(replicas);
    }

    fn sample_stats(&mut self, shares: &BTreeMap<String, i64>) {
        self.stats.maybe_sample(now_millis(), shares);
    }

    fn tick(&mut self) {
        if let Err(msg) = self.tick_inner() {
            eprintln!("[agent] reconcile error: {msg}");
            let status = heartbeat_status(&self.config, &self.agent_version, &msg, &now_iso());
            self.write_status_forced(&status, now_millis());
        }
    }

    fn tick_inner(&mut self) -> Result<(), String> {
        if self.config.role == NodeRole::Edge {
            return self.edge_tick();
        }

        self.errors.clear();
        self.caddy_outcome = no_caddy();

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

        self.has_co_located_web = self.desired.services.iter().any(|s| {
            s.ingress
                .as_ref()
                .map(|i| is_co_located_ingress(&self.config.node_id, i.edge.as_deref()))
                .unwrap_or(false)
        });
        self.fronts_remote_apps = self.config.role == NodeRole::Both;

        let before = docker::inspect_managed()?;
        let actions = plan_reconcile(&self.desired, &before);
        apply_actions(&actions, self);

        self.refresh_caddy(&BTreeSet::new());
        let status = self.current_status()?;
        let reason = self.write_status_maybe(&status, now_millis());
        if self.debug_s3 {
            eprintln!("[agent] s3: status {reason:?}");
        }

        let has_remote_edge = self.desired.services.iter().any(|s| {
            s.ingress
                .as_ref()
                .and_then(|i| i.edge.as_deref())
                .map(|e| e != self.config.node_id)
                .unwrap_or(false)
        });
        if has_remote_edge {
            self.publish_upstream()?;
        }

        // Reconcile CloudWatch log shipping to the containers now running on this node.
        match docker::inspect_managed() {
            Ok(map) => {
                let live: Vec<ManagedReplica> = map.into_values().flatten().collect();
                self.sync_cloudwatch(&live);
            }
            Err(e) => eprintln!("[agent] cloudwatch: {e}"),
        }

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
        self.sample_stats(&shares);
        Ok(())
    }

    fn edge_tick(&mut self) -> Result<(), String> {
        let shards = {
            let h = self.handle.clone();
            h.block_on(list_upstream_shards(
                &self.s3,
                &self.config.bucket,
                &self.config.cluster_id,
                &self.config.node_id,
                Some(&mut self.shard_cache),
            ))?
        };
        let routes = merge_routes_by_domain(build_shard_routes(&shards));
        let edge_routes: Vec<EdgeRouteStatus> = routes
            .iter()
            .map(|r| EdgeRouteStatus {
                domain: r.domain.clone(),
                upstreams: r.upstreams.len() as i64,
            })
            .collect();
        let now = now_iso();
        let outcome = apply_caddy(&routes, &self.caddy_admin, &mut self.caddy_st, &now);
        let status = NodeStatus {
            node_id: self.config.node_id.clone(),
            agent_id: self.config.agent_id.clone(),
            last_seen: now,
            agent_version: self.agent_version.clone(),
            services: Vec::new(),
            caddy: CaddyStatus {
                managed: outcome.managed,
                last_reload_at: outcome.last_reload_at,
                error: outcome.error,
            },
            edge_routes,
        };
        let reason = self.write_status_maybe(&status, now_millis());
        if self.debug_s3 {
            eprintln!("[agent] s3: status {reason:?}");
        }
        // Edge ships system logs only (agent + caddy) — no containers run here.
        self.sync_cloudwatch(&[]);
        self.sample_stats(&BTreeMap::new());
        Ok(())
    }
}

impl Reconciler for AgentReconciler {
    fn pull(&mut self, image: &str) -> Result<(), String> {
        docker::pull(image)
    }
    fn run_container(
        &mut self,
        config: &ServiceConfig,
        index: i64,
        host_port: Option<i64>,
        bind_host: &str,
    ) -> Result<(), String> {
        docker::run_container(config, index, host_port, bind_host)
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
        match config.ingress.as_ref().and_then(|i| i.edge.as_deref()) {
            Some(_) => "0.0.0.0".to_string(),
            None => "127.0.0.1".to_string(),
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
    fn refresh_caddy(&mut self, exclude_ids: &BTreeSet<String>) {
        if !self.has_co_located_web && !self.fronts_remote_apps {
            self.caddy_outcome = no_caddy();
            return;
        }
        match self.build_caddy_routes(exclude_ids) {
            Ok(routes) => {
                let now = now_iso();
                self.caddy_outcome = apply_caddy(&routes, &self.caddy_admin, &mut self.caddy_st, &now);
            }
            Err(e) => eprintln!("[agent] caddy routes: {e}"),
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

fn main() {
    let config = match load_agent_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[agent] config: {e}");
            std::process::exit(1);
        }
    };

    let agent_version = std::env::var("LAUNCHPAD_AGENT_VERSION").unwrap_or_else(|_| "0.0.0".into());
    let interval_ms = env_i64("LAUNCHPAD_POLL_MS", DEFAULT_POLL_INTERVAL_MS);
    let once = std::env::var("LAUNCHPAD_ONCE").as_deref() == Ok("1");
    let debug_s3 = std::env::var("LAUNCHPAD_DEBUG_S3").as_deref() == Ok("1");
    let caddy_admin =
        std::env::var("LAUNCHPAD_CADDY_ADMIN").unwrap_or_else(|_| "http://127.0.0.1:2019".into());

    let resolved = resolve_liveness(
        env_i64("LAUNCHPAD_LIVENESS_MS", LIVENESS_HEARTBEAT_MS) as f64,
        interval_ms,
        HEARTBEAT_STALE_MS,
    );
    for w in &resolved.warnings {
        eprintln!("[agent] liveness: {w}");
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    let (s3, ecr) = rt.block_on(make_clients(&config.region));

    let state_path = state_path();
    let state = load_state(&state_path);

    let stats = StatsSampler::new(
        config.node_id.clone(),
        env_i64("LAUNCHPAD_STATS_INTERVAL_MS", STATS_DEFAULT_INTERVAL_MS),
        std::env::var("LAUNCHPAD_STATS_SERVICES").as_deref() != Ok("0"),
        AgentStatsDeps,
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
        "[agent] starting for node {} role={:?} (bucket {}) poll={}ms liveness={}ms",
        config.node_id, config.role, config.bucket, interval_ms, resolved.liveness_ms
    );

    let mut agent = AgentReconciler {
        handle: rt.handle().clone(),
        s3,
        ecr,
        config,
        agent_version,
        caddy_admin,
        debug_s3,
        state_path,
        state,
        caddy_st: CaddyState::default(),
        write_tracker: WriteTracker {
            fingerprint: None,
            last_write_ms: 0,
        },
        liveness_ms: resolved.liveness_ms,
        last_login_ms: None,
        last_shard_fps: BTreeMap::new(),
        shard_cache: ShardListCache::default(),
        stats,
        cloudwatch,
        desired: DesiredState {
            version: 1,
            node_id: String::new(),
            updated_at: String::new(),
            services: Vec::new(),
        },
        errors: BTreeMap::new(),
        caddy_outcome: no_caddy(),
        has_co_located_web: false,
        fronts_remote_apps: false,
    };

    let term = Arc::new(AtomicBool::new(false));
    let _ = signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&term));
    let _ = signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&term));

    agent.tick();
    if once {
        return;
    }

    while !term.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(interval_ms.max(0) as u64));
        if term.load(Ordering::Relaxed) {
            break;
        }
        agent.tick();
    }
}
