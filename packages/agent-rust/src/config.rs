//! Agent config (`/etc/launch-pad/agent.json`). Mirrors `packages/agent/src/config.ts`.
//!
//! Phase 2 ports the schema + pure parse; the file-reading `loadAgentConfig` (env-
//! overridable path) lands with the main loop in Phase 6.

use serde::{Deserialize, Serialize};

use crate::types::{NodeRole, DEFAULT_CLUSTER};

fn default_cluster() -> String {
    DEFAULT_CLUSTER.to_string()
}

/// The config `node create` writes for the on-box agent (`AgentConfigSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub node_id: String,
    pub agent_id: String,
    pub bucket: String,
    pub region: String,
    /// Scopes this node's S3 keys. Defaults so pre-cluster agent.json parses.
    #[serde(default = "default_cluster")]
    pub cluster_id: String,
    /// "app" (containers, shard publisher) | "edge" (dedicated Caddy router).
    /// REQUIRED — matches the TS `AgentConfigSchema`. The legacy "both" still
    /// parses (enum keeps it) but the binaries refuse to run with it.
    pub role: NodeRole,
    /// External (BYOS) nodes: the IP the edge dials to reach this node's
    /// container host ports. Absent on managed EC2 nodes (the agent falls back
    /// to the IMDS private IP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertise_ip: Option<String>,
}

/// Parse + validate the agent config JSON. Mirrors `AgentConfigSchema.parse`.
pub fn parse_agent_config(json: &str) -> Result<AgentConfig, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

const DEFAULT_CONFIG_PATH: &str = "/etc/launch-pad/agent.json";

/// Load + validate the agent config from `LAUNCHPAD_AGENT_CONFIG` (or the default path).
/// Mirrors `loadAgentConfig`.
pub fn load_agent_config() -> Result<AgentConfig, String> {
    let path =
        std::env::var("LAUNCHPAD_AGENT_CONFIG").unwrap_or_else(|_| DEFAULT_CONFIG_PATH.to_string());
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    parse_agent_config(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_config() {
        let json = r#"{
            "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1",
            "clusterId": "lower", "role": "edge"
        }"#;
        let cfg = parse_agent_config(json).unwrap();
        assert_eq!(
            cfg,
            AgentConfig {
                node_id: "n1".into(),
                agent_id: "a1".into(),
                bucket: "b".into(),
                region: "us-east-1".into(),
                cluster_id: "lower".into(),
                role: NodeRole::Edge,
                advertise_ip: None,
            }
        );
    }

    #[test]
    fn parses_an_external_node_advertise_ip() {
        let json = r#"{
            "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1",
            "role": "app", "advertiseIp": "10.0.2.42"
        }"#;
        let cfg = parse_agent_config(json).unwrap();
        assert_eq!(cfg.advertise_ip.as_deref(), Some("10.0.2.42"));
    }

    #[test]
    fn defaults_advertise_ip_to_none_when_absent() {
        let json = r#"{ "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1", "role": "app" }"#;
        let cfg = parse_agent_config(json).unwrap();
        assert_eq!(cfg.advertise_ip, None);
    }

    #[test]
    fn defaults_cluster_for_a_pre_cluster_config_but_requires_role() {
        // clusterId still defaults (back-compat) …
        let json = r#"{ "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1", "role": "app" }"#;
        let cfg = parse_agent_config(json).unwrap();
        assert_eq!(cfg.cluster_id, "default");
        assert_eq!(cfg.role, NodeRole::App);
        // … but role is required, matching the TS schema.
        let no_role = r#"{ "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1" }"#;
        assert!(parse_agent_config(no_role).is_err());
    }

    #[test]
    fn rejects_a_config_missing_a_required_field() {
        let json = r#"{ "nodeId": "n1", "agentId": "a1", "region": "us-east-1" }"#; // no bucket
        assert!(parse_agent_config(json).is_err());
    }
}
