//! Upstream-shard building. Mirrors `packages/agent/src/upstream.ts`.
//!
//! The TS version stamps `updatedAt` with `Date.now()` internally; for a pure,
//! deterministic port we inject `now` (the main loop supplies it in Phase 6).

use std::collections::BTreeMap;

use crate::docker::ManagedReplica;
use crate::types::{service_key, DesiredState, UpstreamBackend, UpstreamShard};

/// Build upstream shards grouped by edge id from desired state + live replicas.
pub fn build_upstream_shards(
    node_id: &str,
    private_ip: &str,
    desired: &DesiredState,
    live: &BTreeMap<String, Vec<ManagedReplica>>,
    now: &str,
) -> BTreeMap<String, UpstreamShard> {
    let mut shards: BTreeMap<String, UpstreamShard> = BTreeMap::new();

    for c in &desired.services {
        if let Some(ingress) = &c.ingress {
            if let Some(edge) = &ingress.edge {
                shards.entry(edge.clone()).or_insert_with(|| UpstreamShard {
                    node_id: node_id.to_string(),
                    private_ip: private_ip.to_string(),
                    updated_at: now.to_string(),
                    backends: Vec::new(),
                });
            }
        }
    }

    for c in &desired.services {
        let Some(ingress) = &c.ingress else { continue };
        let Some(edge) = &ingress.edge else { continue };
        let Some(shard) = shards.get_mut(edge) else { continue };

        let empty: Vec<ManagedReplica> = Vec::new();
        let reps = live
            .get(&service_key(&c.project, &c.service))
            .unwrap_or(&empty)
            .iter()
            .filter(|r| r.state == "running" && r.host_port.is_some());

        for r in reps {
            shard.backends.push(UpstreamBackend {
                domain: ingress.domain.clone(),
                host_port: r.host_port.unwrap(),
                health_path: c.health_check.as_ref().map(|h| h.path.clone()),
            });
        }
    }

    shards
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HealthCheck, Ingress, Rollout, ServiceConfig};

    fn desired(node_id: &str, edge: &str) -> DesiredState {
        DesiredState {
            version: 1,
            node_id: node_id.into(),
            updated_at: "t".into(),
            services: vec![ServiceConfig {
                project: "p".into(),
                service: "web".into(),
                image: "img".into(),
                cpu: 256,
                memory: 256,
                replicas: 2,
                env: BTreeMap::new(),
                ingress: Some(Ingress {
                    domain: "app.example.com".into(),
                    port: 3000,
                    edge: Some(edge.into()),
                }),
                health_check: Some(HealthCheck {
                    path: "/health".into(),
                    port: None,
                    interval_ms: 10_000,
                    timeout_ms: 3_000,
                    healthy_threshold: 3,
                }),
                rollout: Rollout::default(),
            }],
        }
    }

    fn rep(id: &str, index: i64, state: &str, host_port: i64) -> ManagedReplica {
        ManagedReplica {
            id: id.into(),
            name: format!("n{index}"),
            index,
            project: "p".into(),
            service: "web".into(),
            image: "img".into(),
            cpu: 256,
            memory: 256,
            state: state.into(),
            host_port: Some(host_port),
        }
    }

    #[test]
    fn groups_running_replicas_by_edge_with_health_paths() {
        let mut live: BTreeMap<String, Vec<ManagedReplica>> = BTreeMap::new();
        live.insert(
            "p/web".into(),
            vec![rep("c0", 0, "running", 20001), rep("c1", 1, "starting", 20002)],
        );

        let shards = build_upstream_shards("app-1", "10.0.1.5", &desired("app-1", "edge-1"), &live, "t");
        let shard = shards.get("edge-1").expect("edge-1 shard");
        assert_eq!(shard.private_ip, "10.0.1.5");
        assert_eq!(
            shard.backends,
            vec![UpstreamBackend {
                domain: "app.example.com".into(),
                host_port: 20001,
                health_path: Some("/health".into()),
            }]
        );
    }
}
