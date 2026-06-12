//! Caddy route building. Mirrors `packages/agent/src/routes.ts`.
//!
//! v2 protocol: there is NO co-located ingress — every web service is fronted by the
//! cluster's dedicated edge, so routes are built exclusively from app-published
//! upstream shards.

use std::collections::BTreeMap;

use crate::caddy::WebRoute;
use crate::edge::{build_edge_backends_from_shards, edge_health_path_for_domain};
use crate::types::UpstreamShard;

/// Caddy routes from app-published upstream shards (consumed by the edge node).
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
    use crate::types::{UpstreamBackend, UpstreamShard};

    #[test]
    fn builds_routes_from_upstream_shards() {
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
