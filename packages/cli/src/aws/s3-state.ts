import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { NODES_PREFIX } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import { awsErrorName, awsStatusCode } from "./errors";

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

/** Idempotently ensure the state bucket exists with sane defaults. */
export async function ensureBucket(s3: S3Client, bucket: string, region: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    const status = awsStatusCode(error);
    const name = awsErrorName(error);
    if (status === 403 || name === "Forbidden") {
      throw new CliError(`the state bucket ${bucket} exists but is not accessible (403)`, {
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

export async function deleteObject(s3: S3Client, bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** List the node ids that have a `nodes/<id>/` prefix in the bucket. */
export async function listNodeIds(s3: S3Client, bucket: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: NODES_PREFIX,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const prefix of res.CommonPrefixes ?? []) {
      const value = prefix.Prefix;
      if (value) {
        const id = value.slice(NODES_PREFIX.length, -1);
        if (id) ids.push(id);
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return ids;
}
