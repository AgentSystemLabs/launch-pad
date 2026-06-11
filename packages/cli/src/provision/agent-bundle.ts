import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nodePrefix, type NodeAgentType } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

/** Which agent runtime is installed on a node (TypeScript only; "rust" remains in the shared schema for legacy registry entries). */
export type AgentType = NodeAgentType;

export const DEFAULT_AGENT_TYPE: AgentType = "ts";

export function defaultAgentTypeForBootstrap(_bootstrapMode: "full" | "golden" | undefined): AgentType {
  return "ts";
}

/** S3 key the agent bundle is uploaded to for a node. */
export function agentBundleKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}agent.cjs`;
}

/** Locate the bundled agent (`@agentsystemlabs/launch-pad-agent` main = dist/index.cjs). */
export function resolveAgentBundlePath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("@agentsystemlabs/launch-pad-agent");
  } catch {
    throw new CliError("could not locate the launch-pad agent bundle", {
      hint: "build the workspace first (`pnpm build`)",
    });
  }
}

/** Upload the agent bundle to the node's S3 prefix. */
export async function uploadAgentBundle(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
): Promise<void> {
  const body = readFileSync(resolveAgentBundlePath());
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: agentBundleKey(clusterId, nodeId),
      Body: body,
      ContentType: "application/javascript",
    }),
  );
}

/** Presign a GET URL the node can curl on first boot (no AWS creds needed on-box). */
export async function presignAgentBundle(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: agentBundleKey(clusterId, nodeId) }), {
    expiresIn: expiresInSeconds,
  });
}

/** Upload the agent bundle to S3 and presign its fetch URL. */
export async function uploadAndPresignAgent(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  await uploadAgentBundle(s3, bucket, clusterId, nodeId);
  return presignAgentBundle(s3, bucket, clusterId, nodeId, expiresInSeconds);
}
