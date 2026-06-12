/**
 * Pure planning for `launchpad backup` / `restore`. Backup mirrors a cluster's S3 state
 * (the authoritative registry — `cluster.json`, per-node `node`/`desired`/`status.json`,
 * config baselines, deploy events) into a local directory keyed by the S3 key, plus a
 * manifest. Restore re-uploads it. Kept pure so the prefix selection + the path-safety guards
 * (which stop a crafted backup from writing outside the cluster's own keys on restore) are
 * unit-tested without touching S3 or the filesystem.
 */
import { CLUSTERS_PREFIX, DEFAULT_CLUSTER, NODES_PREFIX } from "@agentsystemlabs/launch-pad-shared";

export const BACKUP_MANIFEST_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "manifest.json";

export interface BackupManifest {
  version: number;
  /** ISO timestamp the backup was taken (stamped by the command, not here). */
  createdAt: string;
  account: string;
  region: string;
  cluster: string;
  bucket: string;
  /** The S3 prefixes that were swept. */
  prefixes: string[];
  /** Every object key captured (relative to the bucket — also the local file path). */
  keys: string[];
}

/**
 * The S3 prefixes that hold a cluster's state. The implicit `default` cluster lives at the
 * legacy un-prefixed `nodes/` + `projects/` roots; a named cluster is fully under
 * `clusters/<id>/`. These never overlap, so a default backup can't capture a named cluster's
 * state (or vice-versa).
 */
export function backupPrefixesForCluster(clusterId: string): string[] {
  if (clusterId === DEFAULT_CLUSTER) return [NODES_PREFIX, "projects/"];
  return [`${CLUSTERS_PREFIX}${clusterId}/`];
}

/**
 * A backup key is safe to materialize locally / restore only when it's a clean relative
 * path: non-empty, not the manifest file, no leading slash or backslash, and no empty / `.` /
 * `..` segment (path traversal). Guards restore against a tampered backup writing outside the
 * intended keyspace.
 */
export function isSafeBackupKey(key: string): boolean {
  if (key.length === 0 || key === BACKUP_MANIFEST_FILE) return false;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  return key.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/** True when `key` sits under one of `prefixes` — the restore guard that keeps an upload
 *  inside the target cluster's own keyspace. */
export function keyUnderPrefixes(key: string, prefixes: string[]): boolean {
  return prefixes.some((p) => key === p || key.startsWith(p));
}
