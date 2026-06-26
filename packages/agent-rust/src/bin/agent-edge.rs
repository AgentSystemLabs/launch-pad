//! Launch Pad EDGE-node agent: the Caddy router. Mirrors the edge half of
//! `packages/agent/src/index.ts` (`edgeTick`).
//!
//! No Docker, no ECR, no SSM, no container reconcile — the edge's only job is
//! S3 upstream shards → Caddy admin-API config, plus status/heartbeat publishing
//! and host-level stats. Built with `--no-default-features --features edge` so the
//! app-only code and its aws-sdk deps aren't compiled in at all.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use launch_pad_agent::aws::{cloudwatch_logs_client, load_sdk_config, s3_client, sqs_client};
use launch_pad_agent::caddy::{apply_caddy, CaddyState};
use launch_pad_agent::cloudwatch_logs::DirectCloudWatchLogsSync;
use launch_pad_agent::config::{load_agent_config, AgentConfig};
use launch_pad_agent::docker::ManagedReplica;
use launch_pad_agent::routes::{build_shard_routes, merge_routes_by_domain};
use launch_pad_agent::runtime::{
    assert_role, env_i64, install_term_flag, load_agent_env, now_iso, now_millis, run_poll_loop,
    wait_or_wake,
};
use launch_pad_agent::sqs::run_sqs_listener;
use launch_pad_agent::s3::{list_upstream_shards, put_status, ShardListCache};
use launch_pad_agent::stats::{StatsDeps, StatsSampler, STATS_DEFAULT_INTERVAL_MS};
use launch_pad_agent::status::heartbeat_status;
use launch_pad_agent::status_write::{
    decide_status_write, fingerprint_status, WriteReason, WriteTracker,
};
use launch_pad_agent::types::{EdgeRouteStatus, NodeRole, NodeStatus};

use tokio::runtime::Handle;

/// Host-only stats: /proc reads, no docker (none is installed on an edge node).
struct EdgeStatsDeps;

impl StatsDeps for EdgeStatsDeps {
    fn read(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| e.to_string())
    }
    fn sleep_ms(&self, ms: i64) {
        std::thread::sleep(Duration::from_millis(ms.max(0) as u64));
    }
    fn docker_stats(&self, _ids: &[String]) -> Result<String, String> {
        Err("docker is not available on an edge node".into())
    }
    fn inspect(&self) -> Result<Vec<ManagedReplica>, String> {
        Ok(Vec::new())
    }
    fn now(&self) -> String {
        now_iso()
    }
}

struct EdgeAgent {
    handle: Handle,
    s3: aws_sdk_s3::Client,
    config: AgentConfig,
    agent_version: String,
    caddy_admin: String,
    debug_s3: bool,

    caddy_st: CaddyState,
    shard_cache: ShardListCache,
    write_tracker: WriteTracker,
    liveness_ms: i64,
    stats: StatsSampler<EdgeStatsDeps>,
    cloudwatch: DirectCloudWatchLogsSync,
}

impl EdgeAgent {
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

    /// Best-effort unconditional PUT (error path); the tracker is only advanced on
    /// success so a failure retries next tick.
    fn write_status_forced(&mut self, status: &NodeStatus, now_ms: i64) {
        match self.put_status_now(status) {
            Ok(()) => {
                self.write_tracker.fingerprint = Some(fingerprint_status(status));
                self.write_tracker.last_write_ms = now_ms;
            }
            Err(e) => eprintln!("[agent] s3 put status: {e}"),
        }
    }

    fn tick(&mut self) {
        if let Err(msg) = self.tick_inner() {
            eprintln!("[agent] reconcile error: {msg}");
            let status = heartbeat_status(&self.config, &self.agent_version, &msg, &now_iso());
            self.write_status_forced(&status, now_millis());
        }
    }

    /// Edge reconcile: read upstream routing shards apps publish into this edge's
    /// prefix, program Caddy to route each domain to healthy replicas over VPC
    /// private IPs, and publish status (write-on-change + liveness heartbeat).
    fn tick_inner(&mut self) -> Result<(), String> {
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
        // apply_caddy probes Caddy's live config each tick, so an out-of-band Caddy
        // restart (crash/OOM/systemctl restart) is detected and force-re-pushed here.
        let caddy = apply_caddy(&routes, &self.caddy_admin, &mut self.caddy_st, &now);
        let status = NodeStatus {
            node_id: self.config.node_id.clone(),
            agent_id: self.config.agent_id.clone(),
            last_seen: now,
            agent_version: self.agent_version.clone(),
            services: Vec::new(),
            caddy,
            edge_routes,
            host: None,
        };
        let reason = self.write_status_maybe(&status, now_millis())?;
        if self.debug_s3 {
            eprintln!("[agent] s3: status {reason:?}");
        }
        // Edge ships system logs only (agent + caddy) — no containers run here.
        let h = self.handle.clone();
        h.block_on(self.cloudwatch.sync(&[], now_millis()));
        // Host-only usage sample (no managed containers on an edge).
        self.stats.maybe_sample(now_millis(), &BTreeMap::new());
        Ok(())
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
    assert_role(&config, NodeRole::Edge, "launchpad-agent-edge");

    let env = load_agent_env();
    for w in &env.liveness.warnings {
        eprintln!("[agent] liveness: {w}");
    }
    let caddy_admin =
        std::env::var("LAUNCHPAD_CADDY_ADMIN").unwrap_or_else(|_| "http://127.0.0.1:2019".into());

    // Caddy may still be starting at boot — warn, don't exit; the tick re-pushes the
    // config as soon as the admin API answers (and surfaces errors into status).
    if ureq::get(&format!("{caddy_admin}/config/")).call().is_err() {
        eprintln!("[agent] warning: caddy admin API at {caddy_admin} is not answering yet");
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    let sdk = rt.block_on(load_sdk_config(&config.region));

    let stats = StatsSampler::new(
        config.node_id.clone(),
        env_i64("LAUNCHPAD_STATS_INTERVAL_MS", STATS_DEFAULT_INTERVAL_MS),
        false, // host-only: no containers, no docker on an edge
        EdgeStatsDeps,
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
        "[agent] starting edge agent for node {} (bucket {}) poll={}ms liveness={}ms",
        config.node_id, config.bucket, env.interval_ms, env.liveness.liveness_ms
    );

    // Capture ids for the SNS→SQS listener before `config` moves into the agent.
    let sqs = sqs_client(&sdk);
    let listener_cluster = config.cluster_id.clone();
    let listener_node = config.node_id.clone();

    let mut agent = EdgeAgent {
        handle: rt.handle().clone(),
        s3: s3_client(&sdk),
        config,
        agent_version: env.agent_version.clone(),
        caddy_admin,
        debug_s3: env.debug_s3,
        caddy_st: CaddyState::default(),
        shard_cache: ShardListCache::default(),
        write_tracker: WriteTracker {
            fingerprint: None,
            last_write_ms: 0,
        },
        liveness_ms: env.liveness.liveness_ms,
        stats,
        cloudwatch,
    };

    let term = install_term_flag();

    // Push half of the hybrid model: a background task long-polls this node's SQS queue
    // for SNS deploy notifications and wakes the loop the instant one lands, so the edge
    // re-reads its upstream shards immediately. Polling stays the fallback.
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
