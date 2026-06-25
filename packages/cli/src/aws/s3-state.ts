import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  backupsBucketName,
  bucketTags,
  CLUSTERS_PREFIX,
  clusterNodesPrefix,
  projectsPrefix,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import { awsErrorName, awsStatusCode } from "./errors";
import { ensureBucketTags } from "./tags";

export interface S3Json {
  /** Decoded JSON body (not yet validated against any schema). */
  raw: unknown;
  /** The object's ETag, for optimistic concurrency on the next write. */
  etag: string;
}

/** Thrown when a conditional PutObject fails its precondition (concurrent write). */
export class PreconditionFailedError extends Error {
  constructor() {
    super("S3 conditional write precondition failed");
    this.name = "PreconditionFailedError";
  }
}

/**
 * Idempotently create-or-adopt a bucket with the hardening every launch-pad bucket
 * shares: a HeadBucket probe (tag + return when it already exists), CreateBucket with
 * the region LocationConstraint for non-us-east-1, BucketAlreadyOwnedByYou tolerance,
 * an all-true PublicAccessBlock, AES256 default encryption, versioning, and tags.
 * `kind` only flavors the 403 error message (state vs. backups). Shared by
 * {@link ensureBucket} and {@link ensureBackupsBucket} so they can't drift.
 */
async function ensureHardenedBucket(
  s3: S3Client,
  bucket: string,
  region: string,
  clusterId: string,
  kind: "state" | "backups",
): Promise<void> {
  const tags = bucketTags({ clusterId });

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    await ensureBucketTags(s3, bucket, tags);
    return;
  } catch (error) {
    const status = awsStatusCode(error);
    const name = awsErrorName(error);
    if (status === 403 || name === "Forbidden") {
      throw new CliError(`the ${kind} bucket ${bucket} exists but is not accessible (403)`, {
        hint: "it may be owned by another AWS account, or your IAM user lacks s3:ListBucket",
      });
    }
    if (status !== 404 && name !== "NotFound" && name !== "NoSuchBucket") {
      throw error;
    }
    // 404 → fall through and create it.
  }

  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  } catch (error) {
    const name = awsErrorName(error);
    // Lost a create race with a concurrent deploy — that's fine.
    if (name !== "BucketAlreadyOwnedByYou") {
      if (name === "BucketAlreadyExists") {
        throw new CliError(`the bucket name ${bucket} is already taken in another AWS account`);
      }
      throw error;
    }
  }

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    }),
  );
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  await ensureBucketTags(s3, bucket, tags);
}

/** Idempotently ensure the state bucket exists with sane defaults. */
export async function ensureBucket(
  s3: S3Client,
  bucket: string,
  region: string,
  clusterId: string,
): Promise<void> {
  await ensureHardenedBucket(s3, bucket, region, clusterId, "state");
}

/**
 * Idempotently ensure the dedicated database-backups bucket
 * (`launch-pad-backups-<acct>-<region>`) exists, hardened identically to the state
 * bucket (private + encrypted + versioned + tagged). Called once per deploy that has
 * a backup-bearing managed database, before publishing the service's backup config.
 */
export async function ensureBackupsBucket(
  s3: S3Client,
  accountId: string,
  region: string,
  clusterId: string,
): Promise<void> {
  await ensureHardenedBucket(s3, backupsBucketName(accountId, region), region, clusterId, "backups");
}

/** Read + JSON-decode an object, or null if it doesn't exist. */
export async function getJson(s3: S3Client, bucket: string, key: string): Promise<S3Json | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (await res.Body?.transformToString()) ?? "";
    return { raw: JSON.parse(body), etag: res.ETag ?? "" };
  } catch (error) {
    if (awsErrorName(error) === "NoSuchKey" || awsStatusCode(error) === 404) {
      return null;
    }
    throw error;
  }
}

/** Read an object's raw body as text, or null if it doesn't exist. Used by `backup` to
 *  capture each state object byte-for-byte (no re-serialization). */
export async function getObjectText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? "";
  } catch (error) {
    if (awsErrorName(error) === "NoSuchKey" || awsStatusCode(error) === 404) return null;
    throw error;
  }
}

/** Write a raw text body. Used by `restore` to re-upload a captured object verbatim. */
export async function putObjectText(
  s3: S3Client,
  bucket: string,
  key: string,
  body: string,
  contentType = "application/json",
): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export interface PutJsonOptions {
  /** Only write if the current object matches this ETag (optimistic update). */
  ifMatch?: string;
  /** Only write if the object does not exist yet. */
  ifNoneMatch?: string;
}

/** Write a value as pretty JSON. Throws PreconditionFailedError on a 412. */
export async function putJson(
  s3: S3Client,
  bucket: string,
  key: string,
  value: unknown,
  options: PutJsonOptions = {},
): Promise<string> {
  try {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: `${JSON.stringify(value, null, 2)}\n`,
        ContentType: "application/json",
        ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
        ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
      }),
    );
    return res.ETag ?? "";
  } catch (error) {
    if (awsErrorName(error) === "PreconditionFailed" || awsStatusCode(error) === 412) {
      throw new PreconditionFailedError();
    }
    throw error;
  }
}

export interface DeleteObjectOptions {
  /** Only delete if the current object still matches this ETag (optimistic delete). */
  ifMatch?: string;
}

/** Delete an object. With `ifMatch`, throws PreconditionFailedError on a 412 (concurrent write). */
export async function deleteObject(
  s3: S3Client,
  bucket: string,
  key: string,
  options: DeleteObjectOptions = {},
): Promise<void> {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
      }),
    );
  } catch (error) {
    if (awsErrorName(error) === "PreconditionFailed" || awsStatusCode(error) === 412) {
      throw new PreconditionFailedError();
    }
    throw error;
  }
}

/**
 * Delete every object under a prefix. Used to fully sweep a node's state on
 * `cluster destroy` — `node.json`/`desired.json`/`status.json` plus advisory
 * objects (`edge.json`, `upstream/*.json`) a per-key delete would orphan. Pages
 * through ListObjectsV2 and batch-deletes (≤1000 keys per DeleteObjects call).
 * Returns the number of objects deleted.
 */
export async function deletePrefix(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
      );
      deleted += keys.length;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/**
 * List every object key under a prefix (flat — no delimiter), paging through results.
 * Keys come back in S3's lexicographic order, so a timestamp-leading naming scheme (e.g.
 * deploy events) lists chronologically. Returns [] when the bucket/prefix is empty.
 */
export async function listObjectKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * List the named cluster ids that have state in S3 (the `clusters/<id>/` prefix).
 * The implicit `default` cluster lives at the legacy un-prefixed `nodes/` root and
 * is NOT listed here — it always exists and has no `cluster.json`. Since the bucket
 * is account+region scoped, every id returned lives in this bucket's region.
 */
export async function listClusterIds(s3: S3Client, bucket: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: CLUSTERS_PREFIX,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      const value = cp.Prefix;
      if (value) {
        const id = value.slice(CLUSTERS_PREFIX.length, -1);
        if (id) ids.push(id);
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids;
}

/** List the footprint owners with per-project state in a cluster's `projects/` prefix. */
export async function listProjectIds(s3: S3Client, bucket: string, clusterId: string): Promise<string[]> {
  const prefix = projectsPrefix(clusterId);
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      const value = cp.Prefix;
      if (value) {
        const id = value.slice(prefix.length, -1);
        // `_`-prefixed directories are registry internals (`projects/_index/`),
        // never a footprint owner (LABEL_REGEX forbids underscores).
        if (id && !id.startsWith("_")) ids.push(id);
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids;
}

/** List the node ids registered in a cluster's prefix. */
export async function listNodeIds(s3: S3Client, bucket: string, clusterId: string): Promise<string[]> {
  const prefix = clusterNodesPrefix(clusterId);
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      const value = cp.Prefix;
      if (value) {
        const id = value.slice(prefix.length, -1);
        if (id) ids.push(id);
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids;
}
