//! Per-node CloudWatch Agent log config. Mirrors
//! `packages/agent/src/cloudwatch-logs.ts`.

use crate::docker::ManagedReplica;
use crate::logs::{
    build_system_log_collect_list, cw_agent_config, cw_log_file_entry, log_group_name,
    log_stream_name, CwAgentConfig, CwLogFileEntry,
};
use crate::types::NodeRole;

/// Where docker's json-file driver writes each container's stdout/stderr.
pub const DOCKER_CONTAINERS_DIR: &str = "/var/lib/docker/containers";

/// The combined (system + container) config the agent applies.
pub const CW_COMBINED_CONFIG_PATH: &str = "/etc/launch-pad/cw-agent-combined.json";

/// Docker json-file log path for a container id.
pub fn container_log_file_path(container_id: &str) -> String {
    format!("{DOCKER_CONTAINERS_DIR}/{container_id}/{container_id}-json.log")
}

/// Pure: map each managed container to a CloudWatch Agent collect_list entry that tails
/// its docker json log file into the service-first group/stream. Entries missing an id,
/// project, or service are skipped.
pub fn build_container_log_collect_list(
    cluster_id: &str,
    node_id: &str,
    replicas: &[ManagedReplica],
) -> Vec<CwLogFileEntry> {
    replicas
        .iter()
        .filter(|r| !r.id.is_empty() && !r.project.is_empty() && !r.service.is_empty())
        .map(|r| {
            cw_log_file_entry(
                container_log_file_path(&r.id),
                log_group_name(cluster_id, &r.project, &r.service),
                log_stream_name(node_id, r.index),
            )
        })
        .collect()
}

/// Pure: this node's system logs (agent, plus caddy on edge/both) followed by one entry
/// per running container.
pub fn build_combined_cloudwatch_config(
    cluster_id: &str,
    node_id: &str,
    role: NodeRole,
    replicas: &[ManagedReplica],
) -> CwAgentConfig {
    let mut list = build_system_log_collect_list(cluster_id, node_id, role);
    list.extend(build_container_log_collect_list(cluster_id, node_id, replicas));
    cw_agent_config(list)
}

type WriteConfigFn = Box<dyn FnMut(&str, &str) -> Result<(), String>>;
type ReloadFn = Box<dyn FnMut(&str) -> Result<(), String>>;
type WarnFn = Box<dyn FnMut(&str)>;

/// A per-node CloudWatch Agent config reconciler. Each `sync()` renders the combined
/// config and, only when it changed since last applied (write-on-change), writes it and
/// reloads the agent. Degraded-safe: any failure is swallowed with a warning, and the
/// fingerprint is left stale so the next tick retries.
pub struct CloudWatchAgentSync {
    cluster_id: String,
    node_id: String,
    role: NodeRole,
    write_config: WriteConfigFn,
    reload: ReloadFn,
    warn: WarnFn,
    last_applied: Option<String>,
}

impl CloudWatchAgentSync {
    pub fn new(
        cluster_id: impl Into<String>,
        node_id: impl Into<String>,
        role: NodeRole,
        write_config: impl FnMut(&str, &str) -> Result<(), String> + 'static,
        reload: impl FnMut(&str) -> Result<(), String> + 'static,
        warn: impl FnMut(&str) + 'static,
    ) -> Self {
        Self {
            cluster_id: cluster_id.into(),
            node_id: node_id.into(),
            role,
            write_config: Box::new(write_config),
            reload: Box::new(reload),
            warn: Box::new(warn),
            last_applied: None,
        }
    }

    /// Reconcile the CloudWatch Agent config to the given live replicas. Never panics.
    pub fn sync(&mut self, replicas: &[ManagedReplica]) {
        let config =
            build_combined_cloudwatch_config(&self.cluster_id, &self.node_id, self.role, replicas);
        let serialized = match serde_json::to_string_pretty(&config) {
            Ok(s) => format!("{s}\n"),
            Err(e) => {
                (self.warn)(&format!(
                    "[agent] cloudwatch: log sync failed (continuing): {e}"
                ));
                return;
            }
        };
        if self.last_applied.as_deref() == Some(serialized.as_str()) {
            return;
        }
        if let Err(e) = (self.write_config)(CW_COMBINED_CONFIG_PATH, &serialized) {
            (self.warn)(&format!(
                "[agent] cloudwatch: log sync failed (continuing): {e}"
            ));
            return;
        }
        if let Err(e) = (self.reload)(CW_COMBINED_CONFIG_PATH) {
            (self.warn)(&format!(
                "[agent] cloudwatch: log sync failed (continuing): {e}"
            ));
            return;
        }
        self.last_applied = Some(serialized);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn replica(id: &str, project: &str, service: &str, index: i64) -> ManagedReplica {
        ManagedReplica {
            id: id.into(),
            name: format!("launchpad_{project}_{service}_{index}"),
            state: "running".into(),
            image: "img".into(),
            cpu: 256,
            memory: 256,
            host_port: None,
            index,
            project: project.into(),
            service: service.into(),
        }
    }

    fn live() -> Vec<ManagedReplica> {
        vec![
            replica("aaa111", "my-app", "api", 0),
            replica("bbb222", "my-app", "api", 1),
            replica("ccc333", "my-app", "worker", 0),
        ]
    }

    #[test]
    fn maps_each_container_to_its_json_log_file_under_the_service_first_group() {
        let list = build_container_log_collect_list("default", "node-1", &live());
        assert_eq!(list.len(), 3);
        assert_eq!(
            list[0],
            cw_log_file_entry(
                container_log_file_path("aaa111"),
                "/launch-pad/default/my-app/api".into(),
                "node-1/0".into(),
            )
        );
        assert_eq!(list[0].timezone, "UTC");
        assert_eq!(list[0].retention_in_days, 7);
        // two replicas of the same service share a group, differ by stream
        assert_eq!(list[1].log_group_name, "/launch-pad/default/my-app/api");
        assert_eq!(list[1].log_stream_name, "node-1/1");
        // a worker (no ingress) is shipped just the same
        assert_eq!(list[2].log_group_name, "/launch-pad/default/my-app/worker");
    }

    #[test]
    fn derives_the_docker_json_file_path_from_the_container_id() {
        assert_eq!(
            container_log_file_path("deadbeef"),
            "/var/lib/docker/containers/deadbeef/deadbeef-json.log"
        );
    }

    #[test]
    fn skips_entries_missing_a_container_id_project_or_service() {
        let list =
            build_container_log_collect_list("default", "node-1", &[replica("", "p", "s", 0)]);
        assert_eq!(list, Vec::new());
    }

    #[test]
    fn prepends_system_entries_agent_only_for_an_app_node() {
        let config = build_combined_cloudwatch_config("default", "app-1", NodeRole::App, &live());
        let list = &config.logs.logs_collected.files.collect_list;
        // 1 system (agent) + 3 containers
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].log_stream_name, "agent");
        assert_eq!(list[0].log_group_name, "/launch-pad/default/system/app-1");
        assert_eq!(
            list[1..].iter().map(|e| e.log_stream_name.as_str()).collect::<Vec<_>>(),
            vec!["app-1/0", "app-1/1", "app-1/0"]
        );
    }

    #[test]
    fn includes_caddy_system_logs_on_edge_both() {
        let config = build_combined_cloudwatch_config("lower", "both-1", NodeRole::Both, &[]);
        let streams: Vec<&str> = config
            .logs
            .logs_collected
            .files
            .collect_list
            .iter()
            .map(|e| e.log_stream_name.as_str())
            .collect();
        assert_eq!(streams, vec!["agent", "caddy"]);
    }

    #[test]
    fn writes_and_reloads_on_first_sync_then_skips_when_unchanged() {
        let writes: Rc<RefCell<Vec<(String, String)>>> = Rc::new(RefCell::new(Vec::new()));
        let reloads = Rc::new(RefCell::new(0usize));

        let w = writes.clone();
        let r = reloads.clone();
        let mut sync = CloudWatchAgentSync::new(
            "default",
            "node-1",
            NodeRole::Both,
            move |path, contents| {
                w.borrow_mut().push((path.to_string(), contents.to_string()));
                Ok(())
            },
            move |_path| {
                *r.borrow_mut() += 1;
                Ok(())
            },
            |_m| {},
        );

        sync.sync(&live());
        assert_eq!(writes.borrow().len(), 1);
        assert_eq!(*reloads.borrow(), 1);
        let (path, contents) = writes.borrow()[0].clone();
        assert_eq!(path, "/etc/launch-pad/cw-agent-combined.json");
        assert!(contents.contains("/launch-pad/default/my-app/api"));

        // identical live set → no churn
        sync.sync(&live());
        assert_eq!(writes.borrow().len(), 1);
        assert_eq!(*reloads.borrow(), 1);

        // a changed set → re-applies
        sync.sync(&live()[0..1]);
        assert_eq!(writes.borrow().len(), 2);
        assert_eq!(*reloads.borrow(), 2);
    }

    #[test]
    fn never_throws_and_retries_next_tick_when_the_cloudwatch_agent_is_missing() {
        let reloads = Rc::new(RefCell::new(0usize));
        let warns = Rc::new(RefCell::new(0usize));

        let r = reloads.clone();
        let wn = warns.clone();
        let mut sync = CloudWatchAgentSync::new(
            "default",
            "node-1",
            NodeRole::App,
            |_path, _contents| Ok(()),
            move |_path| {
                *r.borrow_mut() += 1;
                Err("amazon-cloudwatch-agent-ctl: not found".to_string())
            },
            move |_m| *wn.borrow_mut() += 1,
        );

        sync.sync(&live());
        assert_eq!(*warns.borrow(), 1);
        // fingerprint not advanced on failure → retried
        sync.sync(&live());
        assert_eq!(*reloads.borrow(), 2);
    }
}
