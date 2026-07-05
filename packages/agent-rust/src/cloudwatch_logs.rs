//! Per-node CloudWatch Agent log config. Mirrors
//! `packages/agent/src/cloudwatch-logs.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, SeekFrom};

#[cfg(any(feature = "app", feature = "edge"))]
use aws_sdk_cloudwatchlogs::types::InputLogEvent;
#[cfg(any(feature = "app", feature = "edge"))]
use aws_sdk_cloudwatchlogs::Client as CloudWatchLogsClient;
use chrono::DateTime;

use crate::docker::ManagedReplica;
use crate::logs::{
    build_system_log_collect_list, cw_agent_config, cw_log_file_entry, log_group_name,
    log_stream_name, CwAgentConfig, CwLogFileEntry, LOG_RETENTION_DAYS,
};
use crate::types::NodeRole;

/// Where docker's json-file driver writes each container's stdout/stderr.
pub const DOCKER_CONTAINERS_DIR: &str = "/var/lib/docker/containers";

/// The combined (system + container) config the agent applies.
pub const CW_COMBINED_CONFIG_PATH: &str = "/etc/launch-pad/cw-agent-combined.json";

const DIRECT_MAX_BYTES_PER_FILE: usize = 128 * 1024;
const DIRECT_MAX_EVENTS_PER_STREAM: usize = 1000;

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
    list.extend(build_container_log_collect_list(
        cluster_id, node_id, replicas,
    ));
    cw_agent_config(list)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectLogEvent {
    pub timestamp_ms: i64,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectLogBatch {
    pub file_path: String,
    pub next_offset: u64,
    pub log_group_name: String,
    pub log_stream_name: String,
    pub events: Vec<DirectLogEvent>,
}

#[derive(Debug, Default)]
pub struct LogFileTailer {
    offsets: BTreeMap<String, u64>,
}

fn timestamp_from_docker_json_line(line: &str, fallback_ms: i64) -> i64 {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim_start()) else {
        return fallback_ms;
    };
    let Some(ts) = value.get("time").and_then(|v| v.as_str()) else {
        return fallback_ms;
    };
    DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(fallback_ms)
}

fn events_from_log_chunk(chunk: &str, now_ms: i64) -> Vec<DirectLogEvent> {
    chunk
        .split_inclusive('\n')
        .filter_map(|line| {
            let message = line.trim_end_matches(['\r', '\n']).to_string();
            if message.is_empty() {
                return None;
            }
            Some(DirectLogEvent {
                timestamp_ms: timestamp_from_docker_json_line(&message, now_ms),
                message,
            })
        })
        .collect()
}

impl LogFileTailer {
    pub fn collect(&mut self, entries: &[CwLogFileEntry], now_ms: i64) -> Vec<DirectLogBatch> {
        let mut batches = Vec::new();

        for entry in entries {
            let Ok(mut file) = std::fs::File::open(&entry.file_path) else {
                continue;
            };
            let Ok(meta) = file.metadata() else {
                continue;
            };
            let current_len = meta.len();
            let offset = self
                .offsets
                .get(&entry.file_path)
                .copied()
                .filter(|o| *o <= current_len)
                .unwrap_or(0);
            if offset == current_len {
                continue;
            }
            if file.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut limited = file.take(DIRECT_MAX_BYTES_PER_FILE as u64);
            let mut bytes = Vec::new();
            if limited.read_to_end(&mut bytes).is_err() || bytes.is_empty() {
                continue;
            }
            let next_offset = offset + bytes.len() as u64;
            let chunk = String::from_utf8_lossy(&bytes);
            let events = events_from_log_chunk(&chunk, now_ms);
            if events.is_empty() {
                continue;
            }
            batches.push(DirectLogBatch {
                file_path: entry.file_path.clone(),
                next_offset,
                log_group_name: entry.log_group_name.clone(),
                log_stream_name: entry.log_stream_name.clone(),
                events: events
                    .into_iter()
                    .take(DIRECT_MAX_EVENTS_PER_STREAM)
                    .collect(),
            });
        }

        batches
    }

    pub fn commit(&mut self, batch: &DirectLogBatch) {
        self.offsets
            .insert(batch.file_path.clone(), batch.next_offset);
    }
}

type DirectWarnFn = Box<dyn FnMut(&str)>;

/// Direct SDK-based log shipper. It tails the same files the CloudWatch Agent used to
/// tail, but writes them itself so BYOS nodes do not need a separate agent package.
#[cfg(any(feature = "app", feature = "edge"))]
pub struct DirectCloudWatchLogsSync {
    cluster_id: String,
    node_id: String,
    role: NodeRole,
    client: CloudWatchLogsClient,
    tailer: LogFileTailer,
    ensured_streams: BTreeSet<(String, String)>,
    warn: DirectWarnFn,
}

#[cfg(any(feature = "app", feature = "edge"))]
impl DirectCloudWatchLogsSync {
    pub fn new(
        cluster_id: impl Into<String>,
        node_id: impl Into<String>,
        role: NodeRole,
        client: CloudWatchLogsClient,
        warn: impl FnMut(&str) + 'static,
    ) -> Self {
        Self {
            cluster_id: cluster_id.into(),
            node_id: node_id.into(),
            role,
            client,
            tailer: LogFileTailer::default(),
            ensured_streams: BTreeSet::new(),
            warn: Box::new(warn),
        }
    }

    pub async fn sync(&mut self, replicas: &[ManagedReplica], now_ms: i64) {
        let mut entries = build_system_log_collect_list(&self.cluster_id, &self.node_id, self.role);
        entries.extend(build_container_log_collect_list(
            &self.cluster_id,
            &self.node_id,
            replicas,
        ));
        let batches = self.tailer.collect(&entries, now_ms);
        for batch in batches {
            if let Err(e) = self.put_batch(&batch).await {
                (self.warn)(&format!(
                    "[agent] cloudwatch: direct log sync failed (continuing): {e}"
                ));
            } else {
                self.tailer.commit(&batch);
            }
        }
    }

    async fn ensure_stream(&mut self, group: &str, stream: &str) -> Result<(), String> {
        let key = (group.to_string(), stream.to_string());
        if self.ensured_streams.contains(&key) {
            return Ok(());
        }

        if let Err(e) = self
            .client
            .create_log_group()
            .log_group_name(group)
            .send()
            .await
        {
            let msg = e.to_string();
            if !msg.contains("ResourceAlreadyExists") && !msg.contains("AlreadyExists") {
                return Err(msg);
            }
        }
        if let Err(e) = self
            .client
            .put_retention_policy()
            .log_group_name(group)
            .retention_in_days(LOG_RETENTION_DAYS as i32)
            .send()
            .await
        {
            return Err(e.to_string());
        }
        if let Err(e) = self
            .client
            .create_log_stream()
            .log_group_name(group)
            .log_stream_name(stream)
            .send()
            .await
        {
            let msg = e.to_string();
            if !msg.contains("ResourceAlreadyExists") && !msg.contains("AlreadyExists") {
                return Err(msg);
            }
        }
        self.ensured_streams.insert(key);
        Ok(())
    }

    async fn put_batch(&mut self, batch: &DirectLogBatch) -> Result<(), String> {
        self.ensure_stream(&batch.log_group_name, &batch.log_stream_name)
            .await?;
        let mut events = Vec::with_capacity(batch.events.len());
        for e in &batch.events {
            events.push(
                InputLogEvent::builder()
                    .timestamp(e.timestamp_ms)
                    .message(&e.message)
                    .build()
                    .map_err(|e| e.to_string())?,
            );
        }
        if events.is_empty() {
            return Ok(());
        }
        self.client
            .put_log_events()
            .log_group_name(&batch.log_group_name)
            .log_stream_name(&batch.log_stream_name)
            .set_log_events(Some(events))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

type WriteConfigFn = Box<dyn FnMut(&str, &str) -> Result<(), String>>;
type ReloadFn = Box<dyn FnMut(&str) -> Result<(), String>>;
type WarnFn = Box<dyn FnMut(&str)>;

fn is_missing_cloudwatch_pipeline_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("not found")
        || lower.contains("no such file or directory")
        || lower.contains("amazon-cloudwatch-agent-ctl")
}

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
    unavailable: bool,
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
            unavailable: false,
        }
    }

    /// Reconcile the CloudWatch Agent config to the given live replicas. Never panics.
    pub fn sync(&mut self, replicas: &[ManagedReplica]) {
        if self.unavailable {
            return;
        }
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
            if is_missing_cloudwatch_pipeline_error(&e) {
                self.unavailable = true;
                (self.warn)(
                    "[agent] cloudwatch: CloudWatch Agent is not installed; skipping log sync",
                );
                return;
            }
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
    use std::io::Write;
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
            config_stamp: String::new(),
            cron_fire_ms: None,
            job_run_id: None,
            exit_code: None,
        }
    }

    fn live() -> Vec<ManagedReplica> {
        vec![
            replica("aaa111", "my-app", "api", 0),
            replica("bbb222", "my-app", "api", 1),
            replica("ccc333", "my-app", "worker", 0),
        ]
    }

    fn temp_path(name: &str) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "launch-pad-cloudwatch-{}-{}",
            std::process::id(),
            name
        ));
        path.to_string_lossy().to_string()
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
    fn direct_tailer_reads_only_new_lines_and_tracks_offsets() {
        let path = temp_path("offsets.log");
        std::fs::write(&path, "first\n").unwrap();
        let entry = cw_log_file_entry(path.clone(), "group".into(), "stream".into());
        let mut tailer = LogFileTailer::default();

        let first = tailer.collect(&[entry.clone()], 10);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].events[0].message, "first");

        // Until CloudWatch accepts the batch, the offset is not advanced.
        let retry = tailer.collect(&[entry.clone()], 11);
        assert_eq!(retry[0].events[0].message, "first");
        tailer.commit(&first[0]);

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"second\n")
            .unwrap();
        let second = tailer.collect(&[entry.clone()], 20);
        assert_eq!(second[0].events[0].message, "second");
        tailer.commit(&second[0]);

        let third = tailer.collect(&[entry], 30);
        assert!(third.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn direct_tailer_uses_docker_json_time_when_present() {
        let path = temp_path("docker-json.log");
        std::fs::write(
            &path,
            r#"{"log":"hello\n","stream":"stdout","time":"2026-06-20T00:00:00.123456789Z"}"#,
        )
        .unwrap();
        let entry = cw_log_file_entry(path.clone(), "group".into(), "stream".into());
        let mut tailer = LogFileTailer::default();

        let batches = tailer.collect(&[entry], 999);
        assert_eq!(batches[0].events[0].timestamp_ms, 1_781_913_600_123);
        assert_eq!(
            batches[0].events[0].message,
            r#"{"log":"hello\n","stream":"stdout","time":"2026-06-20T00:00:00.123456789Z"}"#
        );
        let _ = std::fs::remove_file(path);
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
            list[1..]
                .iter()
                .map(|e| e.log_stream_name.as_str())
                .collect::<Vec<_>>(),
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
                w.borrow_mut()
                    .push((path.to_string(), contents.to_string()));
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
    fn disables_log_sync_after_one_warning_when_the_cloudwatch_agent_is_missing() {
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
        // Missing CloudWatch Agent is a supported BYOS state, so it stops retrying noisily.
        sync.sync(&live());
        assert_eq!(*reloads.borrow(), 1);
        assert_eq!(*warns.borrow(), 1);
    }

    #[test]
    fn retries_next_tick_for_non_pipeline_reload_errors() {
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
                Err("reload failed: throttled".to_string())
            },
            move |_m| *wn.borrow_mut() += 1,
        );

        sync.sync(&live());
        sync.sync(&live());
        assert_eq!(*reloads.borrow(), 2);
        assert_eq!(*warns.borrow(), 2);
    }
}
