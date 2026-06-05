//! Ports of pure helpers / wire types from `packages/shared/src`.
//!
//! Phase 1 needs `service_key` plus the `status.json` / upstream-shard shapes that the
//! fingerprint functions hash. The full serde mirror of the remaining shared schemas
//! (desired/config/registry) and their round-trip parsing tests land in Phase 2.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Wire protocol version of `desired.json` / `status.json` (`constants.ts`).
pub const PROTOCOL_VERSION: i64 = 1;

/// The implicit cluster a pre-cluster node belongs to (`constants.ts`).
pub const DEFAULT_CLUSTER: &str = "default";

/// Host-port allocation window for published container ports (`constants.ts`).
pub const HOST_PORT_MIN: i64 = 20000;
pub const HOST_PORT_COUNT: i64 = 10000;

/// Liveness/staleness windows in ms (`constants.ts`).
pub const HEARTBEAT_STALE_MS: i64 = 60_000;
pub const LIVENESS_HEARTBEAT_MS: i64 = 30_000;

/// Default poll interval in ms (`constants.ts`).
pub const DEFAULT_POLL_INTERVAL_MS: i64 = 10_000;

/// Docker label keys launch-pad stamps on managed containers (`constants.ts` `LABELS`).
pub mod labels {
    pub const MANAGED: &str = "launchpad.managed";
    pub const PROJECT: &str = "launchpad.project";
    pub const SERVICE: &str = "launchpad.service";
    pub const IMAGE: &str = "launchpad.image";
    pub const REPLICA: &str = "launchpad.replica";
    pub const CPU: &str = "launchpad.cpu";
    pub const MEMORY: &str = "launchpad.memory";
}

/// `${project}/${service}` — the stable composite key for a service on a node.
/// Mirrors `serviceKey` in `packages/shared/src/desired.ts`.
pub fn service_key(project: &str, service: &str) -> String {
    format!("{project}/{service}")
}

/// A node's role (`registry.ts`): `both` = co-located Caddy (default), `edge` = dedicated
/// router, `app` = containers only / private.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeRole {
    App,
    Edge,
    Both,
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

// ── desired.json (`desired.ts` / `health.ts`) ───────────────────────────────────────

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

/// Web ingress. None on a service means it's a background worker (no Caddy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingress {
    pub domain: String,
    pub port: i64,
    /// Node id of a remote edge that fronts this service, or None = co-located Caddy.
    #[serde(default)]
    pub edge: Option<String>,
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
    pub ingress: Option<Ingress>,
    #[serde(default)]
    pub health_check: Option<HealthCheck>,
    #[serde(default)]
    pub rollout: Rollout,
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
                ingress: Some(Ingress {
                    domain: "app.example.com".into(),
                    port: 3000,
                    edge: None,
                }),
                health_check: Some(HealthCheck {
                    path: "/healthz".into(),
                    port: None,
                    interval_ms: 2000,
                    timeout_ms: 2000,
                    healthy_threshold: 2,
                }),
                rollout: Rollout::default(),
            }],
        };
        let json = serde_json::to_string(&desired).unwrap();
        let parsed = parse_desired_state(&json).unwrap();
        assert_eq!(parsed, desired);
    }

    #[test]
    fn desired_state_applies_defaults_for_omitted_fields() {
        // A service that omits replicas/env/healthCheck/rollout (old/minimal document).
        let json = r#"{
            "version": 1, "nodeId": "n1", "updatedAt": "t",
            "services": [{ "project": "p", "service": "web", "image": "img", "cpu": 256, "memory": 256, "ingress": null }]
        }"#;
        let desired = parse_desired_state(json).unwrap();
        let svc = &desired.services[0];
        assert_eq!(svc.replicas, 1);
        assert!(svc.env.is_empty());
        assert_eq!(svc.health_check, None);
        assert_eq!(svc.ingress, None);
        assert_eq!(svc.rollout, Rollout::default());
    }

    #[test]
    fn parse_desired_state_rejects_an_unsupported_version() {
        let json = r#"{ "version": 2, "nodeId": "n1", "updatedAt": "t", "services": [] }"#;
        assert!(parse_desired_state(json).is_err());
    }

    #[test]
    fn parse_desired_state_rejects_a_missing_required_field() {
        // No nodeId → serde rejects (required field).
        let json = r#"{ "version": 1, "updatedAt": "t", "services": [] }"#;
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
        assert_eq!(serde_json::to_string(&NodeRole::Both).unwrap(), "\"both\"");
        assert_eq!(serde_json::from_str::<NodeRole>("\"app\"").unwrap(), NodeRole::App);
    }
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

/// The node's published `status.json` (`NodeStatusSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
