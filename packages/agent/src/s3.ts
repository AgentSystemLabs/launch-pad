import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  type DesiredState,
  desiredKey,
  edgeUpstreamKey,
  edgeUpstreamPrefix,
  emptyDesiredState,
  parseDesiredState,
  parseUpstreamShard,
  statusKey,
  type NodeStatus,
  type UpstreamShard,
} from "@agentsystemlabs/launch-pad-shared";

function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Read the node's desired state; an absent object means "no services". */
export async function getDesired(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
): Promise<DesiredState> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: desiredKey(clusterId, nodeId) }));
    const body = (await res.Body?.transformToString()) ?? "";
    return parseDesiredState(JSON.parse(body));
  } catch (error) {
    if (isMissing(error)) return emptyDesiredState(nodeId, new Date().toISOString());
    throw error;
  }
}

export async function putStatus(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  status: NodeStatus,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: statusKey(clusterId, status.nodeId),
      Body: `${JSON.stringify(status, null, 2)}\n`,
      ContentType: "application/json",
    }),
  );
}

/** Publish routing telemetry for an edge (written into the edge node's upstream prefix). */
export async function putUpstreamShard(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  edgeId: string,
  appNodeId: string,
  shard: UpstreamShard,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: edgeUpstreamKey(clusterId, edgeId, appNodeId),
      Body: `${JSON.stringify(shard, null, 2)}\n`,
      ContentType: "application/json",
    }),
  );
}

/**
 * In-memory cache so a stable edge can skip the per-shard GETs every tick. The cheap
 * LIST still runs each tick (it's how we detect change without a control plane); only
 * the bodies are re-fetched, and only when a shard key or its ETag actually moved.
 */
export interface ShardListCache {
  /** Hash of the listed (key, ETag) pairs from the last successful fetch. */
  fingerprint: string | null;
  shards: UpstreamShard[];
}

function listFingerprint(listed: { key: string; etag: string }[]): string {
  const lines = [...listed].sort((a, b) => a.key.localeCompare(b.key)).map((l) => `${l.key}@${l.etag}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function fetchShards(s3: S3Client, bucket: string, keys: string[]): Promise<UpstreamShard[]> {
  const shards: UpstreamShard[] = [];
  for (const key of keys) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = (await res.Body?.transformToString()) ?? "";
      shards.push(parseUpstreamShard(JSON.parse(body)));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
  return shards;
}

/** List upstream routing shards published for this edge. */
export async function listUpstreamShards(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  edgeId: string,
  cache?: ShardListCache,
): Promise<UpstreamShard[]> {
  const prefix = edgeUpstreamPrefix(clusterId, edgeId);
  const listed: { key: string; etag: string }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith(".json")) listed.push({ key: obj.Key, etag: obj.ETag ?? "" });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  if (cache) {
    const fingerprint = listFingerprint(listed);
    if (cache.fingerprint === fingerprint) return cache.shards;
    const shards = await fetchShards(s3, bucket, listed.map((l) => l.key));
    cache.fingerprint = fingerprint;
    cache.shards = shards;
    return shards;
  }

  return fetchShards(s3, bucket, listed.map((l) => l.key));
}
