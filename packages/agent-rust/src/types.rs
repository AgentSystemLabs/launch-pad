//! Ports of pure helpers / wire types from `packages/shared/src`.
//!
//! Serde mirror of the shared Zod schemas the agent touches: `desired.json`,
//! `status.json`, upstream shards, and the constants both sides import. Parsing is
//! deliberately LENIENT (unknown fields ignored) — forward-compatible with additive
//! CLI-side schema changes, per the protocol's additive-fields rule.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Wire protocol version of `desired.json` / `status.json` (`constants.ts`).
///
/// v2: dropped the `both` node role and co-located Caddy — `ingress.edge` is a
/// required node id. Every cluster is 1 dedicated edge + ≥1 app node.
/// v3: adds transient one-off job run requests/results for `launchpad job run`.
pub const PROTOCOL_VERSION: i64 = 3;

/// The implicit cluster a pre-cluster node belongs to (`constants.ts`).
pub const DEFAULT_CLUSTER: &str = "default";

/// Host-port allocation window for published container ports (`constants.ts`).
pub const HOST_PORT_MIN: i64 = 20000;
pub const HOST_PORT_COUNT: i64 = 10000;

/// Liveness/staleness windows in ms (`constants.ts`).
pub const HEARTBEAT_STALE_MS: i64 = 60_000;
pub const LIVENESS_HEARTBEAT_MS: i64 = 30_000;

/// Default poll interval in ms (`constants.ts`).
/// Raised from 10s to 60s when SNS/SQS notifications are available (agents receive
/// immediate signals instead of polling frequently).
pub const DEFAULT_POLL_INTERVAL_MS: i64 = 60_000;

/// Docker label keys launch-pad stamps on managed containers (`constants.ts` `LABELS`).
pub mod labels {
    pub const MANAGED: &str = "launchpad.managed";
    pub const PROJECT: &str = "launchpad.project";
    pub const SERVICE: &str = "launchpad.service";
    pub const IMAGE: &str = "launchpad.image";
    pub const REPLICA: &str = "launchpad.replica";
    pub const CPU: &str = "launchpad.cpu";
    pub const MEMORY: &str = "launchpad.memory";
    pub const CONFIG_STAMP: &str = "launchpad.configStamp";
    /// Scheduled-job run marker: the cron FIRE TIME (epoch ms) this container was
    /// started for. Presence distinguishes a cron run container from a long-running
    /// replica; the value is the durable "last fire" record the due-run check reads.
    pub const CRON_FIRE: &str = "launchpad.cronFire";
    /// One-off job run request id. Presence distinguishes a manual job container from
    /// a long-running replica or scheduled cron fire.
    pub const JOB_RUN: &str = "launchpad.jobRun";
}

/// `${project}/${service}` — the stable composite key for a service on a node.
/// Mirrors `serviceKey` in `packages/shared/src/desired.ts`.
pub fn service_key(project: &str, service: &str) -> String {
    format!("{project}/{service}")
}

/// A node's role (`registry.ts`). `both` is a LEGACY value (pre-v2 co-located
/// Caddy) kept parseable so an old `agent.json`/`node.json` doesn't crash the
/// parse — the binaries refuse to run with it (fail closed, clear error).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeRole {
    App,
    Edge,
    Both,
}

impl NodeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeRole::App => "app",
            NodeRole::Edge => "edge",
            NodeRole::Both => "both",
        }
    }
}

/// Parse a duration string like `"20s"`, `"500ms"`, `"1m"` to milliseconds.
/// Mirrors `parseDurationMs` (regex `^(\d+)(ms|s|m)$`); returns 0 on no match.
pub fn parse_duration_ms(duration: &str) -> i64 {
    let digits_end = duration
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(duration.len());
    if digits_end == 0 {
        return 0;
    }
    let Ok(n) = duration[..digits_end].parse::<i64>() else {
        return 0;
    };
    match &duration[digits_end..] {
        "ms" => n,
        "s" => n * 1000,
        "m" => n * 60_000,
        _ => 0,
    }
}

// ── desired.json (`desired.ts` / `health.ts` / `secrets.ts` / `config.ts`) ───────────

fn default_replicas() -> i64 {
    1
}
fn default_interval_ms() -> i64 {
    2000
}
fn default_timeout_ms() -> i64 {
    2000
}
fn default_healthy_threshold() -> i64 {
    2
}

/// Web ingress (v2). None on a service means it's a background worker (no routing).
/// `edge` is the REQUIRED node id of the cluster's dedicated edge that fronts this
/// service — Caddy never co-locates with app containers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingress {
    pub domain: String,
    pub port: i64,
    pub edge: String,
}

/// HTTP health check for a web service (`HealthCheckSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub path: String,
    /// Defaults to the service's ingress port at run time when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    #[serde(default = "default_interval_ms")]
    pub interval_ms: i64,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: i64,
    #[serde(default = "default_healthy_threshold")]
    pub healthy_threshold: i64,
}

/// Rolling-update policy (`RolloutSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rollout {
    #[serde(default = "default_max_surge")]
    pub max_surge: i64,
    #[serde(default = "default_drain_timeout")]
    pub drain_timeout: String,
    #[serde(default = "default_stop_grace")]
    pub stop_grace: String,
}

fn default_max_surge() -> i64 {
    1
}
fn default_drain_timeout() -> String {
    "20s".into()
}
fn default_stop_grace() -> String {
    "30s".into()
}

impl Default for Rollout {
    fn default() -> Self {
        Rollout {
            max_surge: 1,
            drain_timeout: "20s".into(),
            stop_grace: "30s".into(),
        }
    }
}

/// SSM parameter ref resolved by the agent at container start (`SecretRefSchema`).
/// Values are never stored in desired.json — only the parameter path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub name: String,
    pub ssm: String,
}

/// Persistent named volume mounted into a service's container(s) (`VolumeDeclSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDecl {
    /// Volume name — unique within the service; derives the docker volume name.
    pub name: String,
    /// Absolute path inside the container where the volume is mounted.
    pub path: String,
}

/// Managed-database marker (`ServiceDatabaseSchema`, shared `config.ts`). Present on a
/// service desugared from a `[[database]]` block — tells the agent it runs the engine
/// image (no build) and can drive `pg_dump`. Optional so non-database services parse
/// unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDatabase {
    /// Database engine (postgres for now).
    pub engine: String,
    /// Engine version (image tag).
    pub version: String,
    /// Logical databases to back up; empty → the agent enumerates at run time.
    #[serde(default)]
    pub databases: Vec<String>,
}

/// Where (and how often) the agent ships a managed database's `pg_dump` backups
/// (`ServiceBackupConfigSchema`, shared `desired.ts`). The CLI computes
/// `bucket`/`prefix` (it knows account/region/cluster/owner); the agent appends
/// `<database>/<timestamp>.sql.gz`. Present only on a database service with backups
/// enabled; optional so non-database services parse unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBackupConfig {
    /// 5-field UTC cron — when a backup run fires.
    pub schedule: String,
    /// Days of dumps kept per database; older objects are pruned after each run.
    pub retention_days: i64,
    /// Backups bucket name (`launch-pad-backups-<acct>-<region>`).
    pub bucket: String,
    /// Key prefix for this service: `<cluster>/<owner>/<service>/`.
    pub prefix: String,
}

/// Transient one-off job run request (`JobRunRequestSchema`, shared `desired.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRunRequest {
    /// Unique id for this requested run; the CLI waits for this exact id.
    pub id: String,
    /// UTC ISO time the run was requested.
    pub requested_at: String,
}

/// One service inside a node's `desired.json` (`ServiceConfigSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub project: String,
    pub service: String,
    pub image: String,
    pub cpu: i64,
    pub memory: i64,
    #[serde(default = "default_replicas")]
    pub replicas: i64,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// SSM parameter refs resolved by the agent at container start.
    #[serde(default)]
    pub secret_refs: Vec<SecretRef>,
    /// Bumped by `deploy --restart` to roll containers without a new image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_at: Option<String>,
    /// 5-field cron expression (UTC). Present → this is a SCHEDULED job: one
    /// short-lived container per fire instead of a long-running replica set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    pub ingress: Option<Ingress>,
    #[serde(default)]
    pub health_check: Option<HealthCheck>,
    #[serde(default)]
    pub rollout: Rollout,
    /// Persistent named volumes (defaulted so pre-volumes documents parse).
    #[serde(default)]
    pub volumes: Vec<VolumeDecl>,
    /// Managed-database marker (engine/version + logical backup targets). Present →
    /// this service runs an engine image (no build). Optional so non-database
    /// services parse unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<ServiceDatabase>,
    /// S3 backup config; present → the agent runs scheduled backups for this database.
    /// Optional so non-database services parse unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<ServiceBackupConfig>,
    /// Transient one-off job run request. Present only on desired entries written by
    /// `launchpad job run`; normal deploy removes/ignores jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_run: Option<JobRunRequest>,
}

/// Fingerprint of runtime config the agent stamps on containers. Uses secret ref
/// paths (not SSM values) plus plain env, restartAt, and volume mounts — so a change
/// to any of them forces the container to be replaced on the next reconcile.
///
/// ⚠️ Parity with TS `serviceConfigStamp` (shared `secrets.ts`) is LOAD-BEARING for
/// migration: a node upgraded from the TypeScript agent compares this stamp against
/// labels the TS agent wrote — a formatting difference rolls the container on the
/// first Rust tick. serde_json's default (BTreeMap-backed) Map serializes keys
/// sorted, reproducing the TS `stableJson` key sort for the common case.
///
/// Known, accepted divergence: TS sorted with ICU `localeCompare` (locale-dependent,
/// not even stable across Node versions); Rust sorts by byte order (deterministic).
/// The orders differ only when a key pair mixes digits/underscores/case (e.g.
/// `DB_HOST` vs `DB2_HOST`) — such services get ONE zero-downtime rolling replace at
/// TS→Rust migration, then the stamp is stable forever after.
pub fn service_config_stamp(config: &ServiceConfig) -> String {
    let mut refs: Vec<&SecretRef> = config.secret_refs.iter().collect();
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    let mut volumes: Vec<&VolumeDecl> = config.volumes.iter().collect();
    volumes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut obj = serde_json::Map::new();
    obj.insert(
        "env".into(),
        serde_json::to_value(&config.env).expect("env serializes"),
    );
    obj.insert(
        "restartAt".into(),
        match &config.restart_at {
            Some(s) => serde_json::Value::String(s.clone()),
            None => serde_json::Value::Null,
        },
    );
    obj.insert(
        "secretRefs".into(),
        serde_json::to_value(&refs).expect("secretRefs serialize"),
    );
    // Omitted when empty so a volume-less service keeps its pre-volumes stamp — an
    // agent upgrade then doesn't needlessly roll every existing (volume-less) container.
    if !volumes.is_empty() {
        obj.insert(
            "volumes".into(),
            serde_json::to_value(&volumes).expect("volumes serialize"),
        );
    }
    serde_json::Value::Object(obj).to_string()
}

/// A node's `desired.json` (`DesiredStateSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredState {
    pub version: i64,
    pub node_id: String,
    pub updated_at: String,
    #[serde(default)]
    pub services: Vec<ServiceConfig>,
}

/// An empty desired state (no services) — what an absent `desired.json` resolves to.
pub fn empty_desired_state(node_id: &str, now: &str) -> DesiredState {
    DesiredState {
        version: PROTOCOL_VERSION,
        node_id: node_id.to_string(),
        updated_at: now.to_string(),
        services: Vec::new(),
    }
}

/// Parse + validate an upstream shard document. Mirrors `parseUpstreamShard`.
pub fn parse_upstream_shard(json: &str) -> Result<UpstreamShard, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

/// Parse + validate a `desired.json` document. Mirrors `DesiredStateSchema.parse`:
/// rejects a document whose `version` is not [`PROTOCOL_VERSION`] (the Zod `z.literal`).
pub fn parse_desired_state(json: &str) -> Result<DesiredState, String> {
    let desired: DesiredState = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if desired.version != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported desired.json version {} (expected {PROTOCOL_VERSION})",
            desired.version
        ));
    }
    Ok(desired)
}

/// Service lifecycle state rolled up into `status.json` (`packages/shared/src/status.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Pending,
    Pulling,
    Starting,
    Running,
    Stopping,
    Error,
    Stopped,
}

impl ServiceState {
    /// The lowercase wire string (matches the serde representation).
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceState::Pending => "pending",
            ServiceState::Pulling => "pulling",
            ServiceState::Starting => "starting",
            ServiceState::Running => "running",
            ServiceState::Stopping => "stopping",
            ServiceState::Error => "error",
            ServiceState::Stopped => "stopped",
        }
    }
}

/// One replica's status within a service (`ReplicaStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaStatus {
    pub index: i64,
    pub container_id: Option<String>,
    /// null for workers
    pub host_port: Option<i64>,
    pub state: ServiceState,
    pub image: String,
    #[serde(default)]
    pub healthy: bool,
}

/// Rollup for a scheduled (`cron`) service (`CronRunStatusSchema`). All-nullable:
/// a freshly-deployed job has no runs yet, and `nextRunAt` is null for an
/// expression with no upcoming fire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunStatus {
    /// Scheduled fire time (UTC ISO) of the most recently STARTED run.
    pub last_run_at: Option<String>,
    /// Exit code of the last COMPLETED run (null while running / before any run).
    pub last_exit_code: Option<i64>,
    /// Next scheduled fire time (UTC ISO).
    pub next_run_at: Option<String>,
}

/// State of a one-off job run (`JobRunStateSchema`, shared `status.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobRunState {
    Pending,
    Running,
    Succeeded,
    Failed,
}

/// Result rollup for a one-off `launchpad job run` request (`JobRunStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRunStatus {
    pub id: String,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub state: JobRunState,
    #[serde(default)]
    pub message: String,
}

/// Per-logical-database result inside a database service's backup rollup
/// (`DatabaseBackupEntrySchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupEntry {
    pub name: String,
    /// Completion time (UTC ISO) of the last successful dump, or null.
    pub last_success_at: Option<String>,
    /// Size of the last uploaded dump in bytes, or null before any success.
    pub size_bytes: Option<i64>,
}

/// Backup rollup for a managed database service (`DatabaseBackupStatusSchema`).
/// Present only when `[database.backup]` is configured; all-nullable so a
/// freshly-deployed database (no run yet) parses, and optional on ServiceStatus so
/// non-database services are unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupStatus {
    /// Scheduled fire time (UTC ISO) of the most recent backup run, or null.
    pub last_run_at: Option<String>,
    /// Completion time (UTC ISO) of the last run where ALL databases dumped, or null.
    pub last_success_at: Option<String>,
    /// Error from the last run (any database failed / upload failed), or null.
    pub last_error: Option<String>,
    /// Next scheduled fire time (UTC ISO), or null.
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub databases: Vec<DatabaseBackupEntry>,
}

/// One service's rolled-up status (`ServiceStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub project: String,
    pub service: String,
    pub image: String,
    pub state: ServiceState,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub container_id: Option<String>,
    #[serde(default)]
    pub replicas: Vec<ReplicaStatus>,
    #[serde(default)]
    pub desired_replicas: i64,
    #[serde(default)]
    pub running_replicas: i64,
    /// Present only for scheduled (`cron`) services.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<CronRunStatus>,
    /// Present only for managed database services with backups enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<DatabaseBackupStatus>,
    /// Present only for a transient one-off job run request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_run: Option<JobRunStatus>,
    pub updated_at: String,
}

/// Caddy reconcile status (`CaddyStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaddyStatus {
    pub managed: bool,
    pub last_reload_at: Option<String>,
    pub error: Option<String>,
}

/// One edge-fronted route count surfaced in status (`EdgeRouteStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeRouteStatus {
    pub domain: String,
    pub upstreams: i64,
}

/// The node's most recent host-utilization sample, embedded in `status.json` so the
/// CLI (`autoscale run`) can read live CPU/memory without CloudWatch
/// (`HostSampleSchema`). Telemetry, not convergence state — excluded from the
/// write-on-change fingerprint and rides the liveness heartbeat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSample {
    /// Host CPU busy %, 0–100 across all cores.
    pub cpu_percent: f64,
    pub memory_used_mb: f64,
    pub memory_total_mb: f64,
    /// ISO8601 time the sample was taken (staleness is judged by the reader).
    pub sampled_at: String,
}

/// The node's published `status.json` (`NodeStatusSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub node_id: String,
    pub agent_id: String,
    pub last_seen: String,
    pub agent_version: String,
    #[serde(default)]
    pub services: Vec<ServiceStatus>,
    pub caddy: CaddyStatus,
    #[serde(default)]
    pub edge_routes: Vec<EdgeRouteStatus>,
    /// Latest host CPU/memory sample; absent until sampled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostSample>,
}

/// One backend an app node advertises to its edge (`UpstreamBackendSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamBackend {
    pub domain: String,
    pub host_port: i64,
    /// optional — omitted from JSON when absent (matches the Zod `.optional()`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_path: Option<String>,
}

/// An app node's push-based routing shard written into its edge's prefix
/// (`UpstreamShardSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamShard {
    pub node_id: String,
    pub private_ip: String,
    pub updated_at: String,
    #[serde(default)]
    pub backends: Vec<UpstreamBackend>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_key_joins_project_and_service() {
        assert_eq!(service_key("blog", "web"), "blog/web");
    }

    #[test]
    fn parse_duration_ms_handles_units() {
        assert_eq!(parse_duration_ms("20s"), 20_000);
        assert_eq!(parse_duration_ms("500ms"), 500);
        assert_eq!(parse_duration_ms("1m"), 60_000);
        assert_eq!(parse_duration_ms("nope"), 0);
        assert_eq!(parse_duration_ms("20sx"), 0);
    }

    #[test]
    fn desired_state_round_trips_through_json() {
        let desired = DesiredState {
            version: PROTOCOL_VERSION,
            node_id: "n1".into(),
            updated_at: "t".into(),
            services: vec![ServiceConfig {
                project: "p".into(),
                service: "web".into(),
                image: "img:1".into(),
                cpu: 256,
                memory: 256,
                replicas: 2,
                env: BTreeMap::from([("NODE_ENV".to_string(), "production".to_string())]),
                secret_refs: vec![SecretRef {
                    name: "API_KEY".into(),
                    ssm: "/launch-pad/default/p/web/API_KEY".into(),
                }],
                restart_at: None,
                cron: None,
                ingress: Some(Ingress {
                    domain: "app.example.com".into(),
                    port: 3000,
                    edge: "edge-1".into(),
                }),
                health_check: Some(HealthCheck {
                    path: "/healthz".into(),
                    port: None,
                    interval_ms: 2000,
                    timeout_ms: 2000,
                    healthy_threshold: 2,
                }),
                rollout: Rollout::default(),
                volumes: vec![VolumeDecl {
                    name: "data".into(),
                    path: "/data".into(),
                }],
                database: None,
                backup: None,
                job_run: None,
            }],
        };
        let json = serde_json::to_string(&desired).unwrap();
        let parsed = parse_desired_state(&json).unwrap();
        assert_eq!(parsed, desired);
    }

    #[test]
    fn desired_state_applies_defaults_for_omitted_fields() {
        // A service that omits replicas/env/secretRefs/cron/volumes/healthCheck/rollout
        // (pre-cron, pre-volumes document).
        let json = r#"{
            "version": 3, "nodeId": "n1", "updatedAt": "t",
            "services": [{ "project": "p", "service": "web", "image": "img", "cpu": 256, "memory": 256, "ingress": null }]
        }"#;
        let desired = parse_desired_state(json).unwrap();
        let svc = &desired.services[0];
        assert_eq!(svc.replicas, 1);
        assert!(svc.env.is_empty());
        assert!(svc.secret_refs.is_empty());
        assert_eq!(svc.restart_at, None);
        assert_eq!(svc.cron, None);
        assert!(svc.volumes.is_empty());
        assert_eq!(svc.health_check, None);
        assert_eq!(svc.ingress, None);
        assert_eq!(svc.rollout, Rollout::default());
    }

    #[test]
    fn parse_desired_state_rejects_an_unsupported_version() {
        let json = r#"{ "version": 1, "nodeId": "n1", "updatedAt": "t", "services": [] }"#;
        assert!(parse_desired_state(json).is_err());
    }

    #[test]
    fn parse_desired_state_rejects_a_missing_required_field() {
        // No nodeId → serde rejects (required field).
        let json = r#"{ "version": 3, "updatedAt": "t", "services": [] }"#;
        assert!(parse_desired_state(json).is_err());
    }

    #[test]
    fn ingress_edge_is_required_in_v2() {
        // v2 dropped nullable edge — a service whose ingress lacks `edge` must fail.
        let json = r#"{
            "version": 3, "nodeId": "n1", "updatedAt": "t",
            "services": [{ "project": "p", "service": "web", "image": "img", "cpu": 256, "memory": 256,
                           "ingress": { "domain": "d.example.com", "port": 3000 } }]
        }"#;
        assert!(parse_desired_state(json).is_err());
    }

    #[test]
    fn node_status_defaults_services_and_edge_routes_to_empty() {
        let json = r#"{
            "nodeId": "n", "agentId": "a", "lastSeen": "t", "agentVersion": "1",
            "caddy": { "managed": false, "lastReloadAt": null, "error": null }
        }"#;
        let status: NodeStatus = serde_json::from_str(json).unwrap();
        assert!(status.services.is_empty());
        assert!(status.edge_routes.is_empty());
        assert_eq!(status.host, None);
    }

    #[test]
    fn node_status_host_sample_round_trips_and_is_omitted_when_absent() {
        let status = NodeStatus {
            node_id: "n".into(),
            agent_id: "a".into(),
            last_seen: "t".into(),
            agent_version: "1".into(),
            services: vec![],
            caddy: CaddyStatus {
                managed: false,
                last_reload_at: None,
                error: None,
            },
            edge_routes: vec![],
            host: None,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("\"host\""));

        let with_host = NodeStatus {
            host: Some(HostSample {
                cpu_percent: 12.5,
                memory_used_mb: 410.0,
                memory_total_mb: 949.0,
                sampled_at: "2026-01-01T00:00:00.000Z".into(),
            }),
            ..status
        };
        let json = serde_json::to_string(&with_host).unwrap();
        let parsed: NodeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.host, with_host.host);
        assert!(json.contains("\"cpuPercent\":12.5"));
    }

    #[test]
    fn service_status_cron_rollup_is_omitted_for_long_running_services() {
        let status = ServiceStatus {
            project: "p".into(),
            service: "web".into(),
            image: "img".into(),
            state: ServiceState::Running,
            message: "running".into(),
            container_id: None,
            replicas: vec![],
            desired_replicas: 1,
            running_replicas: 1,
            cron: None,
            backup: None,
            job_run: None,
            updated_at: "t".into(),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("\"cron\""));
        // backup is omitted for non-database services (Option::is_none skip).
        assert!(!json.contains("\"backup\""));

        let with_cron = ServiceStatus {
            cron: Some(CronRunStatus {
                last_run_at: Some("2026-01-01T00:05:00.000Z".into()),
                last_exit_code: Some(0),
                next_run_at: None,
            }),
            ..status
        };
        let json = serde_json::to_string(&with_cron).unwrap();
        let parsed: ServiceStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.cron, with_cron.cron);
    }

    #[test]
    fn database_and_backup_round_trip_and_default_for_non_database_services() {
        // A non-database desired.json (no database/backup keys) parses with None.
        let json = r#"{
            "version": 3, "nodeId": "n1", "updatedAt": "t",
            "services": [{ "project": "p", "service": "web", "image": "img", "cpu": 256, "memory": 256, "ingress": null }]
        }"#;
        let desired = parse_desired_state(json).unwrap();
        assert_eq!(desired.services[0].database, None);
        assert_eq!(desired.services[0].backup, None);

        // A managed-database service with backup config round-trips through camelCase JSON.
        let db_json = r#"{
            "version": 3, "nodeId": "n1", "updatedAt": "t",
            "services": [{
                "project": "p", "service": "db", "image": "public.ecr.aws/docker/library/postgres:16",
                "cpu": 512, "memory": 512, "ingress": null,
                "database": { "engine": "postgres", "version": "16", "databases": ["app"] },
                "backup": { "schedule": "0 3 * * *", "retentionDays": 7, "bucket": "launch-pad-backups-acct-region", "prefix": "default/p/db/" }
            }]
        }"#;
        let desired = parse_desired_state(db_json).unwrap();
        let svc = &desired.services[0];
        let database = svc.database.as_ref().expect("database present");
        assert_eq!(database.engine, "postgres");
        assert_eq!(database.version, "16");
        assert_eq!(database.databases, vec!["app".to_string()]);
        let backup = svc.backup.as_ref().expect("backup present");
        assert_eq!(backup.schedule, "0 3 * * *");
        assert_eq!(backup.retention_days, 7);
        assert_eq!(backup.bucket, "launch-pad-backups-acct-region");
        assert_eq!(backup.prefix, "default/p/db/");

        // database.databases defaults to empty when omitted.
        let no_dbs = r#"{
            "version": 3, "nodeId": "n1", "updatedAt": "t",
            "services": [{
                "project": "p", "service": "db", "image": "img", "cpu": 512, "memory": 512, "ingress": null,
                "database": { "engine": "postgres", "version": "16" }
            }]
        }"#;
        let desired = parse_desired_state(no_dbs).unwrap();
        assert!(desired.services[0].database.as_ref().unwrap().databases.is_empty());

        // Status backup rollup serializes camelCase to match the strict CLI zod schema.
        let backup_status = DatabaseBackupStatus {
            last_run_at: Some("2026-06-25T03:00:00.000Z".into()),
            last_success_at: Some("2026-06-25T03:00:05.000Z".into()),
            last_error: None,
            next_run_at: Some("2026-06-26T03:00:00.000Z".into()),
            databases: vec![DatabaseBackupEntry {
                name: "app".into(),
                last_success_at: Some("2026-06-25T03:00:05.000Z".into()),
                size_bytes: Some(4096),
            }],
        };
        let json = serde_json::to_string(&backup_status).unwrap();
        assert!(json.contains("\"lastRunAt\""));
        assert!(json.contains("\"lastSuccessAt\""));
        assert!(json.contains("\"lastError\":null"));
        assert!(json.contains("\"nextRunAt\""));
        assert!(json.contains("\"sizeBytes\":4096"));
        let parsed: DatabaseBackupStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, backup_status);
    }

    fn stamp_config() -> ServiceConfig {
        ServiceConfig {
            project: "p".into(),
            service: "web".into(),
            image: "img".into(),
            cpu: 256,
            memory: 256,
            replicas: 1,
            env: BTreeMap::new(),
            secret_refs: vec![],
            restart_at: None,
            cron: None,
            ingress: None,
            health_check: None,
            rollout: Rollout::default(),
            volumes: vec![],
            database: None,
            backup: None,
            job_run: None,
        }
    }

    #[test]
    fn service_config_stamp_matches_the_ts_byte_format() {
        // Expected strings mirror TS `stableJson` output exactly — key-sorted at every
        // level, no whitespace. Byte parity is load-bearing for TS→Rust migration.
        let bare = stamp_config();
        assert_eq!(
            service_config_stamp(&bare),
            r#"{"env":{},"restartAt":null,"secretRefs":[]}"#
        );

        let mut full = stamp_config();
        full.env = BTreeMap::from([
            ("B_VAR".to_string(), "2".to_string()),
            ("A_VAR".to_string(), "1".to_string()),
        ]);
        full.secret_refs = vec![
            SecretRef { name: "Z_KEY".into(), ssm: "/z".into() },
            SecretRef { name: "A_KEY".into(), ssm: "/a".into() },
        ];
        full.restart_at = Some("2026-06-12T00:00:00.000Z".into());
        full.volumes = vec![VolumeDecl { name: "data".into(), path: "/data".into() }];
        assert_eq!(
            service_config_stamp(&full),
            r#"{"env":{"A_VAR":"1","B_VAR":"2"},"restartAt":"2026-06-12T00:00:00.000Z","secretRefs":[{"name":"A_KEY","ssm":"/a"},{"name":"Z_KEY","ssm":"/z"}],"volumes":[{"name":"data","path":"/data"}]}"#
        );
    }

    #[test]
    fn service_config_stamp_omits_empty_volumes_for_pre_volumes_parity() {
        let mut config = stamp_config();
        config.volumes = vec![];
        assert!(!service_config_stamp(&config).contains("volumes"));
    }

    #[test]
    fn service_config_stamp_sorts_keys_by_byte_order_not_icu_collation() {
        // Documents the accepted TS divergence: ICU `localeCompare` would order
        // DB_HOST before DB2_HOST ('_' sorts low as punctuation), byte order puts
        // DB2_HOST first ('2' = 0x32 < '_' = 0x5F). A TS-stamped container with such
        // a key pair rolls once at migration; the Rust order is deterministic.
        let mut config = stamp_config();
        config.env = BTreeMap::from([
            ("DB_HOST".to_string(), "a".to_string()),
            ("DB2_HOST".to_string(), "b".to_string()),
        ]);
        assert_eq!(
            service_config_stamp(&config),
            r#"{"env":{"DB2_HOST":"b","DB_HOST":"a"},"restartAt":null,"secretRefs":[]}"#
        );
    }

    #[test]
    fn upstream_shard_round_trips_and_omits_absent_health_path() {
        let with_health = r#"{"nodeId":"a","privateIp":"1.2.3.4","updatedAt":"t","backends":[{"domain":"d","hostPort":1,"healthPath":"/h"}]}"#;
        let shard: UpstreamShard = serde_json::from_str(with_health).unwrap();
        assert_eq!(shard.backends[0].health_path.as_deref(), Some("/h"));

        let without = UpstreamShard {
            node_id: "a".into(),
            private_ip: "1.2.3.4".into(),
            updated_at: "t".into(),
            backends: vec![UpstreamBackend {
                domain: "d".into(),
                host_port: 1,
                health_path: None,
            }],
        };
        let serialized = serde_json::to_string(&without).unwrap();
        assert!(!serialized.contains("healthPath"));
    }

    #[test]
    fn enums_serialize_to_lowercase_wire_values() {
        assert_eq!(serde_json::to_string(&ServiceState::Running).unwrap(), "\"running\"");
        assert_eq!(
            serde_json::from_str::<ServiceState>("\"stopped\"").unwrap(),
            ServiceState::Stopped
        );
        // `both` stays parseable (legacy registry entries) even though no binary runs it.
        assert_eq!(serde_json::to_string(&NodeRole::Both).unwrap(), "\"both\"");
        assert_eq!(serde_json::from_str::<NodeRole>("\"app\"").unwrap(), NodeRole::App);
    }
}
