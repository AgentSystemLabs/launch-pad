//! Caddy route building. Mirrors `packages/agent/src/routes.ts`.
//!
//! Ports the three tested pure functions. `buildShardRoutes` (the remote-edge path)
//! depends on `packages/shared/src/edge.ts` helpers and lands with the edge work in
//! Phase 6.

use std::collections::{BTreeMap, BTreeSet};

use crate::caddy::WebRoute;
use crate::docker::ManagedReplica;
use crate::edge::{build_edge_backends_from_shards, edge_health_path_for_domain};
use crate::types::{service_key, DesiredState, UpstreamShard};

/// Web ingress routed by co-located Caddy on this node (no remote edge hop).
pub fn is_co_located_ingress(node_id: &str, edge: Option<&str>) -> bool {
    edge.is_none() || edge == Some(node_id)
}

/// Caddy routes for services whose edge is co-located on this node.
pub fn build_co_located_routes(
    node_id: &str,
    desired: &DesiredState,
    live: &BTreeMap<String, Vec<ManagedReplica>>,
    exclude_ids: &BTreeSet<String>,
) -> Vec<WebRoute> {
    let mut routes = Vec::new();
    for c in &desired.services {
        let Some(ingress) = &c.ingress else { continue };
        if !is_co_located_ingress(node_id, ingress.edge.as_deref()) {
            continue;
        }
        let empty: Vec<ManagedReplica> = Vec::new();
        let reps: Vec<&ManagedReplica> = live
            .get(&service_key(&c.project, &c.service))
            .unwrap_or(&empty)
            .iter()
            .filter(|r| r.state == "running" && r.host_port.is_some() && !exclude_ids.contains(&r.id))
            .collect();
        if reps.is_empty() {
            continue;
        }
        routes.push(WebRoute {
            domain: ingress.domain.clone(),
            upstreams: reps
                .iter()
                .map(|r| format!("127.0.0.1:{}", r.host_port.unwrap()))
                .collect(),
            health_path: c.health_check.as_ref().map(|h| h.path.clone()),
        });
    }
    routes
}

/// Caddy routes from app-published upstream shards (remote edge / both nodes).
pub fn build_shard_routes(shards: &[UpstreamShard]) -> Vec<WebRoute> {
    build_edge_backends_from_shards(shards)
        .into_iter()
        .map(|(domain, list)| WebRoute {
            upstreams: list
                .iter()
                .map(|b| format!("{}:{}", b.private_ip, b.host_port))
                .collect(),
            health_path: edge_health_path_for_domain(shards, &domain),
            domain,
        })
        .collect()
}

/// Merge routes for the same domain by unioning upstreams (round-robin load balancing).
/// Preserves first-seen domain order and keeps the first health path encountered.
pub fn merge_routes_by_domain(routes: Vec<WebRoute>) -> Vec<WebRoute> {
    let mut order: Vec<String> = Vec::new();
    let mut by_domain: BTreeMap<String, WebRoute> = BTreeMap::new();
    for route in routes {
        match by_domain.get_mut(&route.domain) {
            None => {
                order.push(route.domain.clone());
                by_domain.insert(
                    route.domain.clone(),
                    WebRoute {
                        domain: route.domain.clone(),
                        upstreams: route.upstreams.clone(),
                        health_path: route.health_path.clone(),
                    },
                );
            }
            Some(existing) => {
                existing.upstreams.extend(route.upstreams);
                if existing.health_path.is_none() {
                    existing.health_path = route.health_path;
                }
            }
        }
    }
    order
        .into_iter()
        .map(|d| by_domain.remove(&d).expect("domain was inserted"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ingress, Rollout, ServiceConfig};

    fn desired(node_id: &str, edge: Option<&str>) -> DesiredState {
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
                replicas: 1,
                env: BTreeMap::new(),
                ingress: Some(Ingress {
                    domain: "app.example.com".into(),
                    port: 3000,
                    edge: edge.map(|s| s.to_string()),
                }),
                health_check: None,
                rollout: Rollout::default(),
            }],
        }
    }

    #[test]
    fn treats_null_edge_and_self_edge_as_co_located() {
        assert!(is_co_located_ingress("node-1", None));
        assert!(is_co_located_ingress("node-1", Some("node-1")));
        assert!(!is_co_located_ingress("node-1", Some("edge-1")));
    }

    #[test]
    fn routes_co_located_services_to_loopback() {
        let mut live: BTreeMap<String, Vec<ManagedReplica>> = BTreeMap::new();
        live.insert(
            "p/web".into(),
            vec![ManagedReplica {
                id: "c0".into(),
                name: "n0".into(),
                index: 0,
                project: "p".into(),
                service: "web".into(),
                image: "img".into(),
                cpu: 256,
                memory: 256,
                state: "running".into(),
                host_port: Some(20001),
            }],
        );
        let routes = build_co_located_routes(
            "node-1",
            &desired("node-1", Some("node-1")),
            &live,
            &BTreeSet::new(),
        );
        assert_eq!(
            routes,
            vec![WebRoute {
                domain: "app.example.com".into(),
                upstreams: vec!["127.0.0.1:20001".into()],
                health_path: None,
            }]
        );
    }

    #[test]
    fn builds_routes_from_upstream_shards() {
        use crate::types::{UpstreamBackend, UpstreamShard};
        let shards = vec![
            UpstreamShard {
                node_id: "app-1".into(),
                private_ip: "10.0.1.5".into(),
                updated_at: "t".into(),
                backends: vec![UpstreamBackend {
                    domain: "app.example.com".into(),
                    host_port: 20001,
                    health_path: Some("/healthz".into()),
                }],
            },
            UpstreamShard {
                node_id: "app-2".into(),
                private_ip: "10.0.1.6".into(),
                updated_at: "t".into(),
                backends: vec![UpstreamBackend {
                    domain: "app.example.com".into(),
                    host_port: 20002,
                    health_path: None,
                }],
            },
        ];
        assert_eq!(
            build_shard_routes(&shards),
            vec![WebRoute {
                domain: "app.example.com".into(),
                upstreams: vec!["10.0.1.5:20001".into(), "10.0.1.6:20002".into()],
                health_path: Some("/healthz".into()),
            }]
        );
    }

    #[test]
    fn unions_upstreams_for_the_same_domain() {
        let merged = merge_routes_by_domain(vec![
            WebRoute {
                domain: "a.com".into(),
                upstreams: vec!["10.0.0.1:1".into()],
                health_path: Some("/h".into()),
            },
            WebRoute {
                domain: "a.com".into(),
                upstreams: vec!["10.0.0.2:2".into()],
                health_path: None,
            },
        ]);
        assert_eq!(
            merged,
            vec![WebRoute {
                domain: "a.com".into(),
                upstreams: vec!["10.0.0.1:1".into(), "10.0.0.2:2".into()],
                health_path: Some("/h".into()),
            }]
        );
    }
}
