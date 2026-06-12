//! NodeStatus builder. Mirrors `packages/agent/src/status.ts`.
//!
//! The TS version stamps `Date.now()` internally; for a pure, deterministic port we
//! inject `now` (ISO string) and `now_ms` — the main loop supplies the real clock.

use std::collections::BTreeMap;

use chrono::{DateTime, SecondsFormat, Utc};

use crate::config::AgentConfig;
use crate::cron::{next_cron_fire, parse_cron_expression};
use crate::docker::ManagedReplica;
use crate::types::{
    service_key, CaddyStatus, CronRunStatus, DesiredState, HostSample, NodeStatus, ReplicaStatus,
    ServiceConfig, ServiceState, ServiceStatus,
};

/// A Caddy outcome that means "this node does not manage Caddy" — app nodes never
/// touch Caddy in v2 (mirrors the TS `NO_CADDY` constant).
pub fn no_caddy() -> CaddyStatus {
    CaddyStatus {
        managed: false,
        last_reload_at: None,
        error: None,
    }
}

/// Epoch ms → ISO8601 with milliseconds + `Z`, matching JS `Date#toISOString`.
pub fn iso_from_ms(ms: i64) -> Option<String> {
    let dt: DateTime<Utc> = DateTime::from_timestamp_millis(ms)?;
    Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Map a raw docker container state to a launch-pad `ServiceState`.
pub fn map_docker_state(state: &str) -> ServiceState {
    match state {
        "running" => ServiceState::Running,
        "exited" | "dead" => ServiceState::Stopped,
        "created" | "restarting" => ServiceState::Starting,
        _ => ServiceState::Pending,
    }
}

/// Roll a service's replica states up into a single state for the watcher/back-compat.
fn rollup_state(replicas: &[ReplicaStatus], desired_replicas: i64, has_error: bool) -> ServiceState {
    if has_error {
        return ServiceState::Error;
    }
    let running = replicas
        .iter()
        .filter(|r| r.state == ServiceState::Running)
        .count() as i64;
    if running >= desired_replicas && desired_replicas > 0 {
        return ServiceState::Running;
    }
    if running > 0 {
        return ServiceState::Starting;
    }
    if let Some(first) = replicas.first() {
        return first.state;
    }
    ServiceState::Pending
}

struct CronView {
    cron: CronRunStatus,
    state: ServiceState,
    message: String,
}

/// Cron rollup + state/message for a scheduled service. An ARMED schedule (idle
/// between runs) reports state "running" — semantically "operating as designed" —
/// because the ServiceState enum predates cron and adding a value would break old
/// CLIs parsing new status documents. A failed run surfaces through
/// `cron.lastExitCode` and the message, NOT through state "error", so one bad run
/// never wedges a later deploy's convergence watch. Mirrors `cronServiceView`.
fn cron_service_view(
    d: &ServiceConfig,
    reps: &[ManagedReplica],
    error: Option<&String>,
    now_ms: i64,
) -> CronView {
    let runs: Vec<&ManagedReplica> = reps.iter().filter(|r| r.cron_fire_ms.is_some()).collect();
    let latest = runs.iter().fold(None::<&ManagedReplica>, |best, r| match best {
        None => Some(r),
        Some(b) if r.cron_fire_ms.unwrap_or(0) > b.cron_fire_ms.unwrap_or(0) => Some(r),
        Some(b) => Some(b),
    });
    let run_in_progress = latest.is_some_and(|l| l.state == "running");
    let finished = latest.is_some() && !run_in_progress;
    let last_exit_code = if finished {
        latest.and_then(|l| l.exit_code)
    } else {
        None
    };

    // Unparseable expressions are rejected upstream; defensive only.
    let next_run_at = parse_cron_expression(d.cron.as_deref().unwrap_or(""))
        .ok()
        .and_then(|s| next_cron_fire(&s, now_ms))
        .and_then(iso_from_ms);

    let cron = CronRunStatus {
        last_run_at: latest.and_then(|l| l.cron_fire_ms).and_then(iso_from_ms),
        last_exit_code,
        next_run_at: next_run_at.clone(),
    };

    let next_hint = next_run_at
        .map(|n| format!(" · next {n}"))
        .unwrap_or_default();
    if let Some(error) = error {
        return CronView {
            cron,
            state: ServiceState::Error,
            message: error.clone(),
        };
    }
    let message = if run_in_progress {
        format!("run in progress{next_hint}")
    } else if let Some(code) = last_exit_code.filter(|&c| c != 0) {
        format!("last run failed (exit {code}){next_hint}")
    } else if last_exit_code == Some(0) {
        format!("last run ok{next_hint}")
    } else {
        format!("scheduled{next_hint}")
    };
    CronView {
        cron,
        state: ServiceState::Running,
        message,
    }
}

/// Build the NodeStatus to publish after a reconcile pass.
#[allow(clippy::too_many_arguments)]
pub fn build_status(
    config: &AgentConfig,
    agent_version: &str,
    desired: &DesiredState,
    live: &BTreeMap<String, Vec<ManagedReplica>>,
    errors: &BTreeMap<String, String>,
    caddy: &CaddyStatus,
    host: Option<HostSample>,
    now: &str,
    now_ms: i64,
) -> NodeStatus {
    let empty: Vec<ManagedReplica> = Vec::new();

    let services: Vec<ServiceStatus> = desired
        .services
        .iter()
        .map(|d| {
            let key = service_key(&d.project, &d.service);
            let reps = live.get(&key).unwrap_or(&empty);
            let error = errors.get(&key);

            let replicas: Vec<ReplicaStatus> = reps
                .iter()
                .map(|r| {
                    let state = map_docker_state(&r.state);
                    ReplicaStatus {
                        index: r.index,
                        container_id: Some(r.id.clone()),
                        host_port: r.host_port,
                        state,
                        image: r.image.clone(),
                        // Mirrors RUNNING state, not the active health-probe result —
                        // the edge only routes to replicas the agent already
                        // health-gated into the LB during rollout.
                        healthy: state == ServiceState::Running,
                    }
                })
                .collect();

            let running: Vec<&ReplicaStatus> = replicas
                .iter()
                .filter(|r| r.state == ServiceState::Running)
                .collect();

            if d.cron.is_some() {
                let view = cron_service_view(d, reps, error, now_ms);
                return ServiceStatus {
                    project: d.project.clone(),
                    service: d.service.clone(),
                    image: running
                        .first()
                        .map(|r| r.image.clone())
                        .unwrap_or_else(|| d.image.clone()),
                    state: view.state,
                    message: view.message,
                    container_id: running.first().and_then(|r| r.container_id.clone()),
                    running_replicas: running.len() as i64,
                    desired_replicas: d.replicas,
                    replicas,
                    cron: Some(view.cron),
                    updated_at: now.to_string(),
                };
            }

            let state = rollup_state(&replicas, d.replicas, error.is_some());

            ServiceStatus {
                project: d.project.clone(),
                service: d.service.clone(),
                image: running
                    .first()
                    .map(|r| r.image.clone())
                    .unwrap_or_else(|| d.image.clone()),
                state,
                message: error
                    .cloned()
                    .unwrap_or_else(|| state.as_str().to_string()),
                container_id: running.first().and_then(|r| r.container_id.clone()),
                running_replicas: running.len() as i64,
                desired_replicas: d.replicas,
                replicas,
                cron: None,
                updated_at: now.to_string(),
            }
        })
        .collect();

    NodeStatus {
        node_id: config.node_id.clone(),
        agent_id: config.agent_id.clone(),
        last_seen: now.to_string(),
        agent_version: agent_version.to_string(),
        services,
        caddy: caddy.clone(),
        edge_routes: Vec::new(),
        host,
    }
}

/// A minimal heartbeat status used when a whole reconcile pass throws.
pub fn heartbeat_status(
    config: &AgentConfig,
    agent_version: &str,
    message: &str,
    now: &str,
) -> NodeStatus {
    NodeStatus {
        node_id: config.node_id.clone(),
        agent_id: config.agent_id.clone(),
        last_seen: now.to_string(),
        agent_version: agent_version.to_string(),
        services: Vec::new(),
        caddy: CaddyStatus {
            managed: false,
            last_reload_at: None,
            error: Some(message.to_string()),
        },
        edge_routes: Vec::new(),
        host: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ingress, NodeRole, Rollout, ServiceConfig, PROTOCOL_VERSION};

    fn config() -> AgentConfig {
        AgentConfig {
            node_id: "n1".into(),
            agent_id: "a1".into(),
            bucket: "b".into(),
            region: "us-east-1".into(),
            cluster_id: "default".into(),
            role: NodeRole::App,
        }
    }

    fn svc(replicas: i64) -> ServiceConfig {
        ServiceConfig {
            project: "blog".into(),
            service: "web".into(),
            image: "img:1".into(),
            cpu: 256,
            memory: 256,
            replicas,
            env: BTreeMap::new(),
            secret_refs: vec![],
            restart_at: None,
            cron: None,
            ingress: Some(Ingress {
                domain: "app.example.com".into(),
                port: 3000,
                edge: "edge-1".into(),
            }),
            health_check: None,
            rollout: Rollout::default(),
            volumes: vec![],
        }
    }

    fn cron_svc(expr: &str) -> ServiceConfig {
        ServiceConfig {
            service: "job".into(),
            cron: Some(expr.into()),
            ingress: None,
            ..svc(1)
        }
    }

    fn rep(index: i64, state: &str) -> ManagedReplica {
        ManagedReplica {
            id: format!("id-{index}"),
            name: format!("launchpad_blog_web_{index}"),
            index,
            state: state.into(),
            project: "blog".into(),
            service: "web".into(),
            image: "img:1".into(),
            cpu: 256,
            memory: 256,
            host_port: Some(20000 + index),
            config_stamp: String::new(),
            cron_fire_ms: None,
            exit_code: None,
        }
    }

    fn cron_run(fire_ms: i64, state: &str, exit_code: Option<i64>) -> ManagedReplica {
        ManagedReplica {
            service: "job".into(),
            cron_fire_ms: Some(fire_ms),
            exit_code,
            host_port: None,
            ..rep(0, state)
        }
    }

    fn live(key: &str, reps: Vec<ManagedReplica>) -> BTreeMap<String, Vec<ManagedReplica>> {
        let mut m = BTreeMap::new();
        if !reps.is_empty() {
            m.insert(key.to_string(), reps);
        }
        m
    }

    fn caddy() -> CaddyStatus {
        CaddyStatus {
            managed: true,
            last_reload_at: Some("t".into()),
            error: None,
        }
    }

    fn desired(services: Vec<ServiceConfig>) -> DesiredState {
        DesiredState {
            version: PROTOCOL_VERSION,
            node_id: "n1".into(),
            updated_at: "t".into(),
            services,
        }
    }

    fn utc(iso: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn maps_docker_states_to_service_states() {
        assert_eq!(map_docker_state("running"), ServiceState::Running);
        assert_eq!(map_docker_state("exited"), ServiceState::Stopped);
        assert_eq!(map_docker_state("dead"), ServiceState::Stopped);
        assert_eq!(map_docker_state("created"), ServiceState::Starting);
        assert_eq!(map_docker_state("restarting"), ServiceState::Starting);
        assert_eq!(map_docker_state("whatever"), ServiceState::Pending);
    }

    #[test]
    fn iso_from_ms_matches_js_to_iso_string() {
        assert_eq!(
            iso_from_ms(utc("2026-06-11T10:05:00Z")).as_deref(),
            Some("2026-06-11T10:05:00.000Z")
        );
    }

    #[test]
    fn builds_a_running_service_status() {
        let status = build_status(
            &config(),
            "1.2.3",
            &desired(vec![svc(1)]),
            &live("blog/web", vec![rep(0, "running")]),
            &BTreeMap::new(),
            &caddy(),
            None,
            "2026-06-05T00:00:00.000Z",
            0,
        );
        assert_eq!(status.node_id, "n1");
        assert_eq!(status.agent_version, "1.2.3");
        assert_eq!(status.last_seen, "2026-06-05T00:00:00.000Z");
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Running);
        assert_eq!(s.running_replicas, 1);
        assert_eq!(s.desired_replicas, 1);
        assert_eq!(s.image, "img:1");
        assert_eq!(s.message, "running");
        assert_eq!(s.container_id.as_deref(), Some("id-0"));
        assert_eq!(s.replicas[0].state, ServiceState::Running);
        assert!(s.replicas[0].healthy);
        assert_eq!(s.cron, None);
    }

    #[test]
    fn surfaces_an_error_as_the_service_state_and_message() {
        let mut errors = BTreeMap::new();
        errors.insert("blog/web".to_string(), "boom".to_string());
        let status = build_status(
            &config(),
            "1",
            &desired(vec![svc(1)]),
            &live("blog/web", vec![rep(0, "exited")]),
            &errors,
            &caddy(),
            None,
            "t",
            0,
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Error);
        assert_eq!(s.message, "boom");
    }

    #[test]
    fn rolls_up_to_starting_when_not_all_replicas_are_running() {
        let status = build_status(
            &config(),
            "1",
            &desired(vec![svc(2)]),
            &live("blog/web", vec![rep(0, "running"), rep(1, "created")]),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            0,
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Starting);
        assert_eq!(s.running_replicas, 1);
        assert_eq!(s.desired_replicas, 2);
    }

    // ── cron rollup (mirrors cron-status.test.ts) ──

    #[test]
    fn an_armed_cron_service_with_no_runs_reports_running_and_scheduled() {
        let now_ms = utc("2026-06-11T10:02:00Z");
        let status = build_status(
            &config(),
            "1",
            &desired(vec![cron_svc("*/5 * * * *")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            now_ms,
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Running);
        let cron = s.cron.as_ref().expect("cron rollup present");
        assert_eq!(cron.last_run_at, None);
        assert_eq!(cron.last_exit_code, None);
        assert_eq!(cron.next_run_at.as_deref(), Some("2026-06-11T10:05:00.000Z"));
        assert!(s.message.starts_with("scheduled"));
    }

    #[test]
    fn a_completed_run_reports_its_exit_code() {
        let fire = utc("2026-06-11T10:00:00Z");
        let status = build_status(
            &config(),
            "1",
            &desired(vec![cron_svc("*/5 * * * *")]),
            &live("blog/job", vec![cron_run(fire, "exited", Some(0))]),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            utc("2026-06-11T10:02:00Z"),
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Running);
        let cron = s.cron.as_ref().unwrap();
        assert_eq!(cron.last_run_at.as_deref(), Some("2026-06-11T10:00:00.000Z"));
        assert_eq!(cron.last_exit_code, Some(0));
        assert!(s.message.starts_with("last run ok"));
    }

    #[test]
    fn a_failed_run_reports_running_state_with_the_exit_code_in_the_message() {
        // State stays "running" — a failed run must NOT wedge a deploy's
        // convergence watch with state "error".
        let fire = utc("2026-06-11T10:00:00Z");
        let status = build_status(
            &config(),
            "1",
            &desired(vec![cron_svc("*/5 * * * *")]),
            &live("blog/job", vec![cron_run(fire, "exited", Some(3))]),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            utc("2026-06-11T10:02:00Z"),
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Running);
        assert_eq!(s.cron.as_ref().unwrap().last_exit_code, Some(3));
        assert!(s.message.starts_with("last run failed (exit 3)"));
    }

    #[test]
    fn an_in_progress_run_has_a_null_exit_code() {
        let fire = utc("2026-06-11T10:00:00Z");
        let status = build_status(
            &config(),
            "1",
            &desired(vec![cron_svc("*/5 * * * *")]),
            &live("blog/job", vec![cron_run(fire, "running", None)]),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            utc("2026-06-11T10:02:00Z"),
        );
        let s = &status.services[0];
        let cron = s.cron.as_ref().unwrap();
        assert_eq!(cron.last_exit_code, None);
        assert!(s.message.starts_with("run in progress"));
    }

    #[test]
    fn a_cron_service_error_still_surfaces_as_error_state() {
        let mut errors = BTreeMap::new();
        errors.insert("blog/job".to_string(), "pull failed".to_string());
        let status = build_status(
            &config(),
            "1",
            &desired(vec![cron_svc("*/5 * * * *")]),
            &BTreeMap::new(),
            &errors,
            &caddy(),
            None,
            "t",
            utc("2026-06-11T10:02:00Z"),
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Error);
        assert_eq!(s.message, "pull failed");
        assert!(s.cron.is_some());
    }

    // ── host sample embedding (mirrors host-status.test.ts) ──

    #[test]
    fn embeds_the_latest_host_sample_when_present() {
        let host = HostSample {
            cpu_percent: 42.5,
            memory_used_mb: 410.0,
            memory_total_mb: 949.0,
            sampled_at: "2026-06-11T10:00:00.000Z".into(),
        };
        let status = build_status(
            &config(),
            "1",
            &desired(vec![]),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &caddy(),
            Some(host.clone()),
            "t",
            0,
        );
        assert_eq!(status.host, Some(host));
    }

    #[test]
    fn omits_host_before_the_first_sample_for_back_compat() {
        let status = build_status(
            &config(),
            "1",
            &desired(vec![]),
            &BTreeMap::new(),
            &BTreeMap::new(),
            &caddy(),
            None,
            "t",
            0,
        );
        assert_eq!(status.host, None);
        assert!(!serde_json::to_string(&status).unwrap().contains("\"host\""));
    }

    #[test]
    fn heartbeat_status_is_a_minimal_error_status() {
        let status = heartbeat_status(&config(), "1", "tick failed", "t");
        assert!(status.services.is_empty());
        assert!(!status.caddy.managed);
        assert_eq!(status.caddy.error.as_deref(), Some("tick failed"));
        assert_eq!(status.caddy.last_reload_at, None);
        assert_eq!(status.host, None);
    }
}
