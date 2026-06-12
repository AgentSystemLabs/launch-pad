//! CloudWatch Logs naming + CloudWatch-Agent config shaping. Mirrors
//! `packages/shared/src/logs.ts` (the source of truth for log-group/stream names
//! and the `collect_list` entry shape).

use serde::{Deserialize, Serialize};

use crate::types::NodeRole;

/// Default CloudWatch Logs retention applied on first write.
pub const LOG_RETENTION_DAYS: i64 = 7;

/// On-box directory the journald→file forwarders write to (tailed by the CW agent).
pub const SYSTEM_LOG_DIR: &str = "/var/log/launch-pad";

/// Log group for a service footprint: `/launch-pad/{clusterId}/{project}/{service}`.
pub fn log_group_name(cluster_id: &str, project: &str, service: &str) -> String {
    format!("/launch-pad/{cluster_id}/{project}/{service}")
}

/// Log stream within a service group: `{nodeId}/{replicaIndex}`.
pub fn log_stream_name(node_id: &str, replica_index: i64) -> String {
    format!("{node_id}/{replica_index}")
}

/// System (agent + caddy) log group for a node: `/launch-pad/{clusterId}/system/{nodeId}`.
pub fn system_log_group_name(cluster_id: &str, node_id: &str) -> String {
    format!("/launch-pad/{cluster_id}/system/{node_id}")
}

/// The on-box components whose journald output is shipped to the system group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemComponent {
    Agent,
    Caddy,
}

impl SystemComponent {
    pub fn as_str(self) -> &'static str {
        match self {
            SystemComponent::Agent => "agent",
            SystemComponent::Caddy => "caddy",
        }
    }
}

/// System log stream is just the component name: `agent` | `caddy`.
pub fn system_log_stream_name(component: SystemComponent) -> String {
    component.as_str().to_string()
}

/// Forwarded-journald file a system component logs to on the node.
pub fn system_log_file_path(component: SystemComponent) -> String {
    format!("{SYSTEM_LOG_DIR}/{}.log", component.as_str())
}

/// Which system components a role ships: the agent runs everywhere; Caddy only on edge/both.
pub fn system_components_for_role(role: NodeRole) -> Vec<SystemComponent> {
    match role {
        NodeRole::App => vec![SystemComponent::Agent],
        _ => vec![SystemComponent::Agent, SystemComponent::Caddy],
    }
}

/// One `logs.logs_collected.files.collect_list` entry for the CloudWatch Agent.
/// Field names are the literal JSON keys (already snake_case) — no serde rename.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CwLogFileEntry {
    pub file_path: String,
    pub log_group_name: String,
    pub log_stream_name: String,
    pub timezone: String,
    pub retention_in_days: i64,
}

pub fn cw_log_file_entry(
    file_path: String,
    log_group_name: String,
    log_stream_name: String,
) -> CwLogFileEntry {
    CwLogFileEntry {
        file_path,
        log_group_name,
        log_stream_name,
        timezone: "UTC".into(),
        retention_in_days: LOG_RETENTION_DAYS,
    }
}

/// The subset of the CloudWatch Agent config document launch-pad writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CwAgentConfig {
    pub logs: CwLogs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CwLogs {
    pub logs_collected: CwLogsCollected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CwLogsCollected {
    pub files: CwFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CwFiles {
    pub collect_list: Vec<CwLogFileEntry>,
}

/// Wrap a collect_list into a full (partial) CloudWatch Agent config document.
pub fn cw_agent_config(collect_list: Vec<CwLogFileEntry>) -> CwAgentConfig {
    CwAgentConfig {
        logs: CwLogs {
            logs_collected: CwLogsCollected {
                files: CwFiles { collect_list },
            },
        },
    }
}

/// collect_list entries for a node's own system logs (agent, plus caddy on edge/both).
pub fn build_system_log_collect_list(
    cluster_id: &str,
    node_id: &str,
    role: NodeRole,
) -> Vec<CwLogFileEntry> {
    system_components_for_role(role)
        .into_iter()
        .map(|component| {
            cw_log_file_entry(
                system_log_file_path(component),
                system_log_group_name(cluster_id, node_id),
                system_log_stream_name(component),
            )
        })
        .collect()
}
