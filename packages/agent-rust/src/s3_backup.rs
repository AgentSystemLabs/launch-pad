//! S3 I/O for the managed-database backup sidecar (app role only).
//!
//! Backups go to a SEPARATE bucket (`launch-pad-backups-<acct>-<region>`) from the
//! state bucket — the bucket/prefix are computed by the CLI and carried in
//! `ServiceBackupConfig`. These helpers reuse the same `aws-sdk-s3` client the agent
//! already builds for state; they only touch the backups bucket the config names.

use std::path::Path;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

/// Upload a local dump file to `bucket/key`. Streams from disk (the dump can be large)
/// rather than buffering the body in memory.
pub async fn put_backup_object(
    s3: &S3Client,
    bucket: &str,
    key: &str,
    path: &Path,
) -> Result<(), String> {
    let body = ByteStream::from_path(path)
        .await
        .map_err(|e| format!("read dump {}: {e}", path.display()))?;
    s3.put_object()
        .bucket(bucket)
        .key(key)
        .body(body)
        .content_type("application/gzip")
        .send()
        .await
        .map_err(|e| format!("put backup {key}: {e}"))?;
    Ok(())
}

/// List every object key under `prefix` in `bucket` (paginated).
pub async fn list_backup_keys(
    s3: &S3Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut keys: Vec<String> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = s3.list_objects_v2().bucket(bucket).prefix(prefix);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("list backups {prefix}: {e}"))?;
        for obj in res.contents() {
            if let Some(k) = obj.key() {
                keys.push(k.to_string());
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
    Ok(keys)
}

/// Delete one object key from `bucket` (a pruned, expired dump).
pub async fn delete_backup_object(s3: &S3Client, bucket: &str, key: &str) -> Result<(), String> {
    s3.delete_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("delete backup {key}: {e}"))?;
    Ok(())
}
