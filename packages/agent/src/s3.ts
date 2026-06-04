import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  type DesiredState,
  desiredKey,
  emptyDesiredState,
  type NodeStatus,
  parseDesiredState,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";

function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** Read the node's desired state; an absent object means "no services". */
export async function getDesired(
  s3: S3Client,
  bucket: string,
  nodeId: string,
): Promise<DesiredState> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: desiredKey(nodeId) }));
    const body = (await res.Body?.transformToString()) ?? "";
    return parseDesiredState(JSON.parse(body));
  } catch (error) {
    if (isMissing(error)) return emptyDesiredState(nodeId, new Date().toISOString());
    throw error;
  }
}

export async function putStatus(s3: S3Client, bucket: string, status: NodeStatus): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: statusKey(status.nodeId),
      Body: `${JSON.stringify(status, null, 2)}\n`,
      ContentType: "application/json",
    }),
  );
}
