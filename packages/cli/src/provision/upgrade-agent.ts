import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { nodeRegistryKey } from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { type Ec2Observation, describeInstancesById } from "../aws/ec2";
import { ensureSsmManagedPolicyForNode } from "../aws/iam";
import { runShellScriptOnInstances } from "../aws/run-command";
import { putJson } from "../aws/s3-state";
import { CliError } from "../errors";
import { uploadAndPresignAgent } from "./agent-bundle";
import {
  AGENT_SYSTEMD_UNIT,
  renderRemoteUpgradeScript,
  ssmRunBashScript,
  TS_AGENT_INSTALL_PATH,
} from "./agent-upgrade";

/**
 * Lifetime of the presigned agent-bundle URL used during an upgrade. Short on
 * purpose — it only needs to outlive the SSM install (or a human copy-paste of
 * the manual fallback). `manualUpgradeHint` derives its "valid for N min" text
 * from this, so the displayed expiry can't drift from the real one.
 */
const UPGRADE_PRESIGN_TTL_SECONDS = 900;

/** Cap on SSM stdout/stderr echoed into an error message. */
const SSM_ERROR_DETAIL_MAX = 400;

export type UpgradeDelivery = "ssm" | "manual" | "upload-only";

export interface UpgradeAgentResult {
  nodeId: string;
  instanceId: string | null;
  agentType: NodeRegistryEntry["agentType"];
  delivery: UpgradeDelivery;
  bundleUrl?: string;
  error?: string;
}

export interface UpgradeAgentParams {
  aws: AwsEnv;
  entry: NodeRegistryEntry;
  agentVersion: string;
  /** Upload to S3 but do not restart the on-box agent. */
  uploadOnly?: boolean;
  onProgress?: (text: string) => void;
}

function requireRunningInstance(obs: Ec2Observation, nodeId: string): void {
  if (obs.kind === "running") return;
  const detail =
    obs.kind === "stopped"
      ? "instance is stopped"
      : obs.kind === "transitional"
        ? `instance is ${obs.state}`
        : obs.kind === "missing"
          ? "instance is gone"
          : "instance is not running";
  throw new CliError(`can't upgrade agent on "${nodeId}" — ${detail}`, {
    hint: "start it with `launch-pad node resume` or reconcile drift first",
  });
}

/** Upload the local agent bundle to S3 and install it on the node's EC2 instance. */
export async function upgradeAgentOnNode(p: UpgradeAgentParams): Promise<UpgradeAgentResult> {
  const { aws, entry, agentVersion } = p;
  const report = p.onProgress ?? (() => {});
  const { nodeId, clusterId } = entry;

  if (!entry.instanceId) {
    throw new CliError(`node "${nodeId}" has no EC2 instance yet`, {
      hint: "provision it with `launch-pad node create` or deploy with auto-create",
    });
  }

  const obsMap = await describeInstancesById(aws.ec2, [entry.instanceId]);
  const obs = obsMap.get(entry.instanceId) ?? { kind: "missing" as const };
  requireRunningInstance(obs, nodeId);

  report(`uploading agent bundle for ${nodeId}`);
  const bundleUrl = await uploadAndPresignAgent(
    aws.s3,
    aws.bucket,
    clusterId,
    nodeId,
    UPGRADE_PRESIGN_TTL_SECONDS,
  );

  if (p.uploadOnly) {
    await updateRegistryAgentVersion(aws, entry, agentVersion);
    return { nodeId, instanceId: entry.instanceId, agentType: "ts", delivery: "upload-only", bundleUrl };
  }

  report(`installing on ${entry.instanceId} via SSM`);
  await ensureSsmManagedPolicyForNode(aws.iam, entry);

  const script = renderRemoteUpgradeScript(bundleUrl);
  try {
    const outcomes = await runShellScriptOnInstances(
      aws.ssm,
      [entry.instanceId],
      ssmRunBashScript(script),
    );
    const result = outcomes[0];
    if (!result) {
      throw new Error("SSM returned no invocation result");
    }
    if (result.status !== "Success") {
      const detail = (result.stderr || result.stdout).trim().slice(0, SSM_ERROR_DETAIL_MAX);
      throw new Error(detail || `SSM status ${result.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodeId,
      instanceId: entry.instanceId,
      agentType: entry.agentType,
      delivery: "manual",
      bundleUrl,
      error: message,
    };
  }

  await updateRegistryAgentVersion(aws, entry, agentVersion);
  return { nodeId, instanceId: entry.instanceId, agentType: "ts", delivery: "ssm" };
}

async function updateRegistryAgentVersion(
  aws: AwsEnv,
  entry: NodeRegistryEntry,
  agentVersion: string,
): Promise<void> {
  const updated: NodeRegistryEntry = { ...entry, agentVersion, agentType: "ts" };
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(entry.clusterId, entry.nodeId), updated);
}

/** EC2 Instance Connect / SSH fallback steps when SSM is unavailable. */
export function manualUpgradeHint(
  nodeId: string,
  bundleUrl: string,
  ttlSeconds = UPGRADE_PRESIGN_TTL_SECONDS,
): string {
  // Inline the real (quoted) URL into the curl line so the block is copy-paste
  // runnable as-is — the old `<presigned-url>` placeholder forced the operator to
  // hunt for the URL on a separate line. The TTL note is derived from the same
  // constant used to sign the URL, so it can't claim a wrong expiry.
  return [
    `  ${nodeId}:`,
    `    curl -fsSL '${bundleUrl}' -o /tmp/launch-pad-agent.cjs`,
    `    sudo install -m 755 /tmp/launch-pad-agent.cjs ${TS_AGENT_INSTALL_PATH}`,
    `    sudo systemctl restart ${AGENT_SYSTEMD_UNIT}`,
    "",
    "  Connect with EC2 Instance Connect (console) or SSH if the node has port 22 open.",
    `  (Presigned URL valid for ~${Math.round(ttlSeconds / 60)} min.)`,
  ].join("\n");
}
