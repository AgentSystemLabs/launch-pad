import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { nodePrefix, type NodeAgentType } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

/** Which agent runtime to install on a node. */
export type AgentType = NodeAgentType;

export const DEFAULT_AGENT_TYPE: AgentType = "rust";

export function defaultAgentTypeForBootstrap(bootstrapMode: "full" | "golden" | undefined): AgentType {
  return bootstrapMode === "golden" ? "rust" : "ts";
}

/** S3 key the agent bundle is uploaded to for a node. */
export function agentBundleKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}agent.cjs`;
}

/** S3 key the Rust agent binary is uploaded to for a node. */
export function agentBinaryKey(clusterId: string, nodeId: string): string {
  return `${nodePrefix(clusterId, nodeId)}agent`;
}

/**
 * Locate the cross-compiled Rust agent binary (exploration: a static
 * `x86_64-unknown-linux-musl` build). Set `LAUNCHPAD_RUST_AGENT_BINARY` to point at it;
 * falls back to the in-repo target dir.
 */
export function resolveAgentBinaryPath(): string {
  const fromEnv = process.env.LAUNCHPAD_RUST_AGENT_BINARY;
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    throw new CliError(`rust agent binary not found at LAUNCHPAD_RUST_AGENT_BINARY=${fromEnv}`);
  }
  // Best-effort in-repo default (dev runs); the env var is the reliable path.
  const require = createRequire(import.meta.url);
  try {
    const shared = require.resolve("@agentsystemlabs/launch-pad-shared");
    // …/packages/shared/dist/index.cjs → repo root is four levels up.
    const root = shared.replace(/\/packages\/shared\/.*$/, "");
    const guess = `${root}/packages/agent-rust/target/x86_64-unknown-linux-musl/release/launch-pad-agent`;
    if (existsSync(guess)) return guess;
  } catch {
    /* fall through to the error */
  }
  throw new CliError("could not locate the Rust agent binary", {
    hint: "cross-compile it (`cargo zigbuild --release --target x86_64-unknown-linux-musl` in packages/agent-rust) and set LAUNCHPAD_RUST_AGENT_BINARY",
  });
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

/** Upload the Rust agent binary to the node's S3 prefix. */
export async function uploadAgentBinary(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
): Promise<void> {
  const body = readFileSync(resolveAgentBinaryPath());
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: agentBinaryKey(clusterId, nodeId),
      Body: body,
      ContentType: "application/octet-stream",
    }),
  );
}

/** Presign a GET URL the node curls to fetch the Rust agent binary. */
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

/** Upload the right agent artifact for the chosen runtime and presign its fetch URL. */
export async function uploadAndPresignAgent(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  nodeId: string,
  agentType: AgentType,
  expiresInSeconds = 3600,
): Promise<string> {
  if (agentType === "rust") {
    await uploadAgentBinary(s3, bucket, clusterId, nodeId);
    return presignAgentBinary(s3, bucket, clusterId, nodeId, expiresInSeconds);
  }
  await uploadAgentBundle(s3, bucket, clusterId, nodeId);
  return presignAgentBundle(s3, bucket, clusterId, nodeId, expiresInSeconds);
}
