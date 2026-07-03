import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  nodePrefix,
  type NodeAgentType,
  type NodeArchitecture,
  type ProvisionNodeRole,
  distDirForArchitecture,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

/**
 * Which agent runtime is installed on a node. "rust" is canonical — every newly
 * provisioned or upgraded node runs the Rust binary; "ts" remains in the shared
 * schema only so legacy registry entries parse (doctor warns on them).
 */
export type AgentType = NodeAgentType;

export const DEFAULT_AGENT_TYPE: AgentType = "rust";

/**
 * S3 key the role-specific agent binary is uploaded to for a node. Per-node (not
 * per-cluster) so the key always holds the binary matching THIS node's role, and a
 * presigned GET needs no role disambiguation. Legacy nodes may still have an
 * `agent.cjs` sibling from the TypeScript era — it's inert once upgraded.
 */
export function agentBinaryKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}agent`;
}

/**
 * Locate the prebuilt linux agent binary for a role + architecture inside the
 * `@agentsystemlabs/launch-pad-agent` package (`dist/<arch>/agent-edge` /
 * `dist/<arch>/agent-app`, produced by `pnpm build:agent` via cargo-zigbuild).
 */
export function resolveAgentBinaryPath(role: ProvisionNodeRole, architecture: NodeArchitecture): string {
  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve("@agentsystemlabs/launch-pad-agent/package.json");
  } catch {
    throw new CliError("could not locate the launchpad agent package", {
      hint: "install workspace dependencies first (`pnpm install`)",
    });
  }
  const binary = join(dirname(packageJson), "dist", distDirForArchitecture(architecture), `agent-${role}`);
  try {
    readFileSync(binary, { flag: "r" }).byteLength;
  } catch {
    throw new CliError(`agent binary for role "${role}" (${architecture}) is missing (${binary})`, {
      hint: "build the linux agent binaries first (`pnpm build:agent` — requires the Rust toolchain + cargo-zigbuild)",
    });
  }
  return binary;
}

/** Upload the role's agent binary to the node's S3 prefix. */
export async function uploadAgentBinary(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  role: ProvisionNodeRole,
  architecture: NodeArchitecture,
): Promise<void> {
  const body = readFileSync(resolveAgentBinaryPath(role, architecture));
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: agentBinaryKey(clusterId, nodeId),
      Body: body,
      ContentType: "application/octet-stream",
    }),
  );
}

/** Presign a GET URL the node can curl on first boot (no AWS creds needed on-box). */
export async function presignAgentBinary(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: agentBinaryKey(clusterId, nodeId) }), {
    expiresIn: expiresInSeconds,
  });
}

/** Upload the role's agent binary to S3 and presign its fetch URL. */
export async function uploadAndPresignAgent(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  role: ProvisionNodeRole,
  architecture: NodeArchitecture,
  expiresInSeconds = 3600,
): Promise<string> {
  await uploadAgentBinary(s3, bucket, clusterId, nodeId, role, architecture);
  return presignAgentBinary(s3, bucket, clusterId, nodeId, expiresInSeconds);
}
