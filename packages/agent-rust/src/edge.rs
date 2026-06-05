//! Edge read-path helpers. Mirrors the pure functions in `packages/shared/src/edge.ts`
//! that the edge/`both` agent uses to turn app-published upstream shards into routes.

use std::collections::BTreeMap;

use crate::types::UpstreamShard;

/// One upstream target an edge routes to (an app replica reachable over the VPC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeBackend {
    pub domain: String,
    pub private_ip: String,
    pub host_port: i64,
}

/// Build Caddy upstreams from app-published routing shards (edge agent read path),
/// grouped per domain in first-seen order.
pub fn build_edge_backends_from_shards(shards: &[UpstreamShard]) -> Vec<(String, Vec<EdgeBackend>)> {
    let mut order: Vec<String> = Vec::new();
    let mut by_domain: BTreeMap<String, Vec<EdgeBackend>> = BTreeMap::new();
    for shard in shards {
        for b in &shard.backends {
            if !by_domain.contains_key(&b.domain) {
                order.push(b.domain.clone());
            }
            by_domain.entry(b.domain.clone()).or_default().push(EdgeBackend {
                domain: b.domain.clone(),
                private_ip: shard.private_ip.clone(),
                host_port: b.host_port,
            });
        }
    }
    order
        .into_iter()
        .map(|d| {
            let backends = by_domain.remove(&d).expect("domain was inserted");
            (d, backends)
        })
        .collect()
}

/// First health path published for a domain across shards (for Caddy active checks).
pub fn edge_health_path_for_domain(shards: &[UpstreamShard], domain: &str) -> Option<String> {
    for shard in shards {
        for b in &shard.backends {
            if b.domain == domain {
                if let Some(path) = &b.health_path {
                    return Some(path.clone());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::UpstreamBackend;

    fn shard(node_id: &str, ip: &str, backends: Vec<UpstreamBackend>) -> UpstreamShard {
        UpstreamShard {
            node_id: node_id.into(),
            private_ip: ip.into(),
            updated_at: "t".into(),
            backends,
        }
    }

    fn backend(domain: &str, host_port: i64, health_path: Option<&str>) -> UpstreamBackend {
        UpstreamBackend {
            domain: domain.into(),
            host_port,
            health_path: health_path.map(|s| s.to_string()),
        }
    }

    #[test]
    fn groups_backends_across_shards_by_domain() {
        let shards = vec![
            shard("app-1", "10.0.1.5", vec![backend("a.com", 20001, Some("/h"))]),
            shard("app-2", "10.0.1.6", vec![backend("a.com", 20001, None)]),
        ];
        let grouped = build_edge_backends_from_shards(&shards);
        assert_eq!(grouped.len(), 1);
        let (domain, backends) = &grouped[0];
        assert_eq!(domain, "a.com");
        assert_eq!(
            backends,
            &vec![
                EdgeBackend {
                    domain: "a.com".into(),
                    private_ip: "10.0.1.5".into(),
                    host_port: 20001
                },
                EdgeBackend {
                    domain: "a.com".into(),
                    private_ip: "10.0.1.6".into(),
                    host_port: 20001
                },
            ]
        );
    }

    #[test]
    fn finds_the_first_health_path_for_a_domain() {
        let shards = vec![
            shard("app-1", "10.0.1.5", vec![backend("a.com", 20001, None)]),
            shard("app-2", "10.0.1.6", vec![backend("a.com", 20001, Some("/health"))]),
        ];
        assert_eq!(
            edge_health_path_for_domain(&shards, "a.com").as_deref(),
            Some("/health")
        );
        assert_eq!(edge_health_path_for_domain(&shards, "missing.com"), None);
    }
}
