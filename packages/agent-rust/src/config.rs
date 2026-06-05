//! Agent config (`/etc/launch-pad/agent.json`). Mirrors `packages/agent/src/config.ts`.
//!
//! Phase 2 ports the schema + pure parse; the file-reading `loadAgentConfig` (env-
//! overridable path) lands with the main loop in Phase 6.

use serde::{Deserialize, Serialize};

use crate::types::{NodeRole, DEFAULT_CLUSTER};

fn default_cluster() -> String {
    DEFAULT_CLUSTER.to_string()
}

fn default_role_both() -> NodeRole {
    NodeRole::Both
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
    /// "app" | "edge" | "both" — defaults to "both" so pre-role agent.json parses.
    #[serde(default = "default_role_both")]
    pub role: NodeRole,
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
            }
        );
    }

    #[test]
    fn defaults_cluster_and_role_for_a_pre_cluster_config() {
        // Old agent.json without clusterId/role still parses (back-compat).
        let json = r#"{ "nodeId": "n1", "agentId": "a1", "bucket": "b", "region": "us-east-1" }"#;
        let cfg = parse_agent_config(json).unwrap();
        assert_eq!(cfg.cluster_id, "default");
        assert_eq!(cfg.role, NodeRole::Both);
    }

    #[test]
    fn rejects_a_config_missing_a_required_field() {
        let json = r#"{ "nodeId": "n1", "agentId": "a1", "region": "us-east-1" }"#; // no bucket
        assert!(parse_agent_config(json).is_err());
    }
}
