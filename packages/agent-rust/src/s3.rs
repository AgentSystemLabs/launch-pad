//! Pure S3 key/bucket derivation. Mirrors `packages/shared/src/s3-keys.ts`.
//!
//! State is scoped by cluster: the `default` cluster uses the legacy un-prefixed
//! `nodes/<id>/` root; a named cluster scopes under `clusters/<clusterId>/nodes/<id>/`.
//!
//! The async `S3` client trait (get_desired / put_status / put_shard / list_shards) is
//! the Phase-6 seam over `aws-sdk-s3`; these key functions are everything the wire
//! contract needs and stay pure + offline.

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use sha2::{Digest, Sha256};

use crate::types::{
    empty_desired_state, parse_desired_state, parse_upstream_shard, DesiredState, NodeStatus,
    UpstreamShard, DEFAULT_CLUSTER,
};

pub const NODES_PREFIX: &str = "nodes/";
pub const CLUSTERS_PREFIX: &str = "clusters/";

/// Fingerprint the listed `(key, etag)` pairs so a stable edge can skip per-shard GETs.
/// Mirrors `listFingerprint` (sort by key, join `key@etag`, sha256-hex).
pub fn list_fingerprint(listed: &[(String, String)]) -> String {
    let mut items: Vec<&(String, String)> = listed.iter().collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));
    let joined = items
        .iter()
        .map(|(k, e)| format!("{k}@{e}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut hasher = Sha256::new();
    hasher.update(joined.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn state_bucket_name(account_id: &str, region: &str) -> String {
    format!("launch-pad-state-{account_id}-{region}")
}

/// Root prefix for a cluster's per-node state.
pub fn cluster_nodes_prefix(cluster_id: &str) -> String {
    if cluster_id == DEFAULT_CLUSTER {
        NODES_PREFIX.to_string()
    } else {
        format!("{CLUSTERS_PREFIX}{cluster_id}/{NODES_PREFIX}")
    }
}

/// `cluster.json` for a named cluster (the `default` cluster has none).
pub fn cluster_config_key(cluster_id: &str) -> String {
    format!("{CLUSTERS_PREFIX}{cluster_id}/cluster.json")
}

pub fn node_prefix(cluster_id: &str, node_id: &str) -> String {
    format!("{}{node_id}/", cluster_nodes_prefix(cluster_id))
}

pub fn node_registry_key(cluster_id: &str, node_id: &str) -> String {
    format!("{}node.json", node_prefix(cluster_id, node_id))
}

pub fn desired_key(cluster_id: &str, node_id: &str) -> String {
    format!("{}desired.json", node_prefix(cluster_id, node_id))
}

pub fn status_key(cluster_id: &str, node_id: &str) -> String {
    format!("{}status.json", node_prefix(cluster_id, node_id))
}

/// Advisory edge config at `<node prefix>/edge.json`.
pub fn edge_config_key(cluster_id: &str, node_id: &str) -> String {
    format!("{}edge.json", node_prefix(cluster_id, node_id))
}

/// Prefix where app agents publish routing shards for an edge: `<edge prefix>/upstream/`.
pub fn edge_upstream_prefix(cluster_id: &str, edge_id: &str) -> String {
    format!("{}upstream/", node_prefix(cluster_id, edge_id))
}

/// Routing shard an app agent writes: `<edge prefix>/upstream/<appNodeId>.json`.
pub fn edge_upstream_key(cluster_id: &str, edge_id: &str, app_node_id: &str) -> String {
    format!("{}{app_node_id}.json", edge_upstream_prefix(cluster_id, edge_id))
}

/// ECR repository name for a service: `<project>/<service>`.
pub fn ecr_repository_name(project: &str, service: &str) -> String {
    format!("{project}/{service}")
}

/// Frozen launch-pad.toml snapshot key for post-deploy config locking (per footprint).
pub fn config_baseline_key(cluster_id: &str, owner_project: &str) -> String {
    let prefix = if cluster_id == DEFAULT_CLUSTER {
        String::new()
    } else {
        format!("{CLUSTERS_PREFIX}{cluster_id}/")
    };
    format!("{prefix}projects/{owner_project}/config-baseline.json")
}

// ── async S3 client (the Phase-6 I/O seam over aws-sdk-s3) ───────────────────────────

/// In-memory cache so a stable edge skips per-shard GETs (only bodies are re-fetched,
/// and only when a shard key or its ETag actually moved).
#[derive(Debug, Default)]
pub struct ShardListCache {
    pub fingerprint: Option<String>,
    pub shards: Vec<UpstreamShard>,
}

/// Read the node's desired state; an absent object means "no services".
pub async fn get_desired(
    s3: &S3Client,
    bucket: &str,
    cluster_id: &str,
    node_id: &str,
    now: &str,
) -> Result<DesiredState, String> {
    let key = desired_key(cluster_id, node_id);
    match s3.get_object().bucket(bucket).key(&key).send().await {
        Ok(out) => {
            let body = read_body(out.body).await?;
            parse_desired_state(&body)
        }
        Err(e) => {
            let svc = e.into_service_error();
            if svc.is_no_such_key() {
                Ok(empty_desired_state(node_id, now))
            } else {
                Err(format!("get_desired {key}: {svc}"))
            }
        }
    }
}

pub async fn put_status(
    s3: &S3Client,
    bucket: &str,
    cluster_id: &str,
    status: &NodeStatus,
) -> Result<(), String> {
    let key = status_key(cluster_id, &status.node_id);
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(status).map_err(|e| e.to_string())?
    );
    s3.put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body.into_bytes()))
        .content_type("application/json")
        .send()
        .await
        .map_err(|e| format!("put_status: {e}"))?;
    Ok(())
}

/// Publish routing telemetry for an edge (written into the edge node's upstream prefix).
pub async fn put_upstream_shard(
    s3: &S3Client,
    bucket: &str,
    cluster_id: &str,
    edge_id: &str,
    app_node_id: &str,
    shard: &UpstreamShard,
) -> Result<(), String> {
    let key = edge_upstream_key(cluster_id, edge_id, app_node_id);
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(shard).map_err(|e| e.to_string())?
    );
    s3.put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body.into_bytes()))
        .content_type("application/json")
        .send()
        .await
        .map_err(|e| format!("put_upstream_shard: {e}"))?;
    Ok(())
}

/// List upstream routing shards published for this edge (with optional ETag cache).
pub async fn list_upstream_shards(
    s3: &S3Client,
    bucket: &str,
    cluster_id: &str,
    edge_id: &str,
    cache: Option<&mut ShardListCache>,
) -> Result<Vec<UpstreamShard>, String> {
    let prefix = edge_upstream_prefix(cluster_id, edge_id);
    let mut listed: Vec<(String, String)> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = s3.list_objects_v2().bucket(bucket).prefix(&prefix);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let res = req.send().await.map_err(|e| format!("list shards: {e}"))?;
        for obj in res.contents() {
            if let Some(k) = obj.key() {
                if k.ends_with(".json") {
                    listed.push((k.to_string(), obj.e_tag().unwrap_or("").to_string()));
                }
            }
        }
        if res.is_truncated().unwrap_or(false) {
            token = res.next_continuation_token().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        } else {
            break;
        }
    }

    let keys: Vec<String> = listed.iter().map(|(k, _)| k.clone()).collect();
    if let Some(cache) = cache {
        let fingerprint = list_fingerprint(&listed);
        if cache.fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return Ok(cache.shards.clone());
        }
        let shards = fetch_shards(s3, bucket, &keys).await?;
        cache.fingerprint = Some(fingerprint);
        cache.shards = shards.clone();
        Ok(shards)
    } else {
        fetch_shards(s3, bucket, &keys).await
    }
}

async fn fetch_shards(
    s3: &S3Client,
    bucket: &str,
    keys: &[String],
) -> Result<Vec<UpstreamShard>, String> {
    let mut shards = Vec::new();
    for key in keys {
        match s3.get_object().bucket(bucket).key(key).send().await {
            Ok(out) => {
                let body = read_body(out.body).await?;
                shards.push(parse_upstream_shard(&body)?);
            }
            Err(e) => {
                let svc = e.into_service_error();
                if svc.is_no_such_key() {
                    continue;
                }
                return Err(format!("fetch shard {key}: {svc}"));
            }
        }
    }
    Ok(shards)
}

async fn read_body(body: ByteStream) -> Result<String, String> {
    let data = body.collect().await.map_err(|e| e.to_string())?.into_bytes();
    String::from_utf8(data.to_vec()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_an_account_region_scoped_bucket_name() {
        assert_eq!(
            state_bucket_name("493255580566", "us-east-1"),
            "launch-pad-state-493255580566-us-east-1"
        );
    }

    #[test]
    fn derives_node_scoped_keys_for_the_default_cluster_at_the_legacy_root() {
        assert_eq!(node_prefix("default", "node-prod-1"), "nodes/node-prod-1/");
        assert_eq!(node_registry_key("default", "node-prod-1"), "nodes/node-prod-1/node.json");
        assert_eq!(desired_key("default", "node-prod-1"), "nodes/node-prod-1/desired.json");
        assert_eq!(status_key("default", "node-prod-1"), "nodes/node-prod-1/status.json");
    }

    #[test]
    fn scopes_a_named_clusters_nodes_under_clusters_id_nodes() {
        assert_eq!(cluster_nodes_prefix("lower"), "clusters/lower/nodes/");
        assert_eq!(node_prefix("lower", "dev-app"), "clusters/lower/nodes/dev-app/");
        assert_eq!(node_registry_key("lower", "dev-app"), "clusters/lower/nodes/dev-app/node.json");
        assert_eq!(desired_key("lower", "dev-app"), "clusters/lower/nodes/dev-app/desired.json");
        assert_eq!(cluster_config_key("lower"), "clusters/lower/cluster.json");
    }

    #[test]
    fn derives_an_ecr_repo_name_from_project_and_service() {
        assert_eq!(ecr_repository_name("my-app", "web"), "my-app/web");
    }

    #[test]
    fn derives_a_per_footprint_config_baseline_key() {
        assert_eq!(
            config_baseline_key("default", "edge-express-web"),
            "projects/edge-express-web/config-baseline.json"
        );
        assert_eq!(
            config_baseline_key("lower", "edge-express-web-staging"),
            "clusters/lower/projects/edge-express-web-staging/config-baseline.json"
        );
    }

    #[test]
    fn list_fingerprint_is_order_independent_and_change_sensitive() {
        let a = vec![("k2".to_string(), "e2".to_string()), ("k1".to_string(), "e1".to_string())];
        let b = vec![("k1".to_string(), "e1".to_string()), ("k2".to_string(), "e2".to_string())];
        assert_eq!(list_fingerprint(&a), list_fingerprint(&b)); // sorted by key
        let c = vec![("k1".to_string(), "e1".to_string()), ("k2".to_string(), "CHANGED".to_string())];
        assert_ne!(list_fingerprint(&a), list_fingerprint(&c)); // an etag moved
    }

    #[test]
    fn derives_edge_upstream_shard_keys_under_the_edge_node_prefix() {
        assert_eq!(edge_upstream_prefix("default", "edge-1"), "nodes/edge-1/upstream/");
        assert_eq!(
            edge_upstream_key("default", "edge-1", "app-1"),
            "nodes/edge-1/upstream/app-1.json"
        );
        assert_eq!(
            edge_upstream_key("lower", "edge-1", "app-1"),
            "clusters/lower/nodes/edge-1/upstream/app-1.json"
        );
    }
}
