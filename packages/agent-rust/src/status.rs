//! NodeStatus builder. Mirrors `packages/agent/src/status.ts`.
//!
//! The TS version stamps `now` with `Date.now()` internally; for a pure, deterministic
//! port we inject `now` (the main loop supplies it in Phase 6).

use std::collections::BTreeMap;

use crate::caddy::CaddyOutcome;
use crate::config::AgentConfig;
use crate::docker::ManagedReplica;
use crate::types::{
    service_key, CaddyStatus, DesiredState, NodeStatus, ReplicaStatus, ServiceState, ServiceStatus,
};

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

/// Build the NodeStatus to publish after a reconcile pass.
pub fn build_status(
    config: &AgentConfig,
    agent_version: &str,
    desired: &DesiredState,
    live: &BTreeMap<String, Vec<ManagedReplica>>,
    errors: &BTreeMap<String, String>,
    caddy: &CaddyOutcome,
    now: &str,
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
                        healthy: state == ServiceState::Running,
                    }
                })
                .collect();

            let running: Vec<&ReplicaStatus> = replicas
                .iter()
                .filter(|r| r.state == ServiceState::Running)
                .collect();
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
        caddy: CaddyStatus {
            managed: caddy.managed,
            last_reload_at: caddy.last_reload_at.clone(),
            error: caddy.error.clone(),
        },
        edge_routes: Vec::new(),
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ingress, NodeRole, Rollout, ServiceConfig};

    fn config() -> AgentConfig {
        AgentConfig {
            node_id: "n1".into(),
            agent_id: "a1".into(),
            bucket: "b".into(),
            region: "us-east-1".into(),
            cluster_id: "default".into(),
            role: NodeRole::Both,
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
            ingress: Some(Ingress {
                domain: "app.example.com".into(),
                port: 3000,
                edge: None,
            }),
            health_check: None,
            rollout: Rollout::default(),
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
        }
    }

    fn live(reps: Vec<ManagedReplica>) -> BTreeMap<String, Vec<ManagedReplica>> {
        let mut m = BTreeMap::new();
        if !reps.is_empty() {
            m.insert("blog/web".to_string(), reps);
        }
        m
    }

    fn caddy() -> CaddyOutcome {
        CaddyOutcome {
            managed: true,
            last_reload_at: Some("t".into()),
            error: None,
        }
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
    fn builds_a_running_service_status() {
        let status = build_status(
            &config(),
            "1.2.3",
            &DesiredState {
                version: 1,
                node_id: "n1".into(),
                updated_at: "t".into(),
                services: vec![svc(1)],
            },
            &live(vec![rep(0, "running")]),
            &BTreeMap::new(),
            &caddy(),
            "2026-06-05T00:00:00.000Z",
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
    }

    #[test]
    fn surfaces_an_error_as_the_service_state_and_message() {
        let mut errors = BTreeMap::new();
        errors.insert("blog/web".to_string(), "boom".to_string());
        let status = build_status(
            &config(),
            "1",
            &DesiredState {
                version: 1,
                node_id: "n1".into(),
                updated_at: "t".into(),
                services: vec![svc(1)],
            },
            &live(vec![rep(0, "exited")]),
            &errors,
            &caddy(),
            "t",
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
            &DesiredState {
                version: 1,
                node_id: "n1".into(),
                updated_at: "t".into(),
                services: vec![svc(2)],
            },
            &live(vec![rep(0, "running"), rep(1, "created")]),
            &BTreeMap::new(),
            &caddy(),
            "t",
        );
        let s = &status.services[0];
        assert_eq!(s.state, ServiceState::Starting);
        assert_eq!(s.running_replicas, 1);
        assert_eq!(s.desired_replicas, 2);
    }

    #[test]
    fn heartbeat_status_is_a_minimal_error_status() {
        let status = heartbeat_status(&config(), "1", "tick failed", "t");
        assert!(status.services.is_empty());
        assert!(!status.caddy.managed);
        assert_eq!(status.caddy.error.as_deref(), Some("tick failed"));
        assert_eq!(status.caddy.last_reload_at, None);
    }
}
