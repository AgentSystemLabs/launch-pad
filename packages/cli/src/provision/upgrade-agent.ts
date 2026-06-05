import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { nodeRegistryKey } from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { type Ec2Observation, describeInstancesById } from "../aws/ec2";
import { ensureSsmManagedPolicyForNode } from "../aws/iam";
import { runShellScriptOnInstances } from "../aws/run-command";
import { putJson } from "../aws/s3-state";
import { CliError } from "../errors";
import { presignAgentBundle, uploadAgentBundle } from "./agent-bundle";
import {
  AGENT_INSTALL_PATH,
  AGENT_SYSTEMD_UNIT,
  renderRemoteUpgradeScript,
  ssmRunBashScript,
} from "./agent-upgrade";

export type UpgradeDelivery = "ssm" | "manual" | "upload-only";

export interface UpgradeAgentResult {
  nodeId: string;
  instanceId: string | null;
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
  await uploadAgentBundle(aws.s3, aws.bucket, clusterId, nodeId);

  const bundleUrl = await presignAgentBundle(aws.s3, aws.bucket, clusterId, nodeId, 900);

  if (p.uploadOnly) {
    await updateRegistryAgentVersion(aws, entry, agentVersion);
    return { nodeId, instanceId: entry.instanceId, delivery: "upload-only", bundleUrl };
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
      const detail = (result.stderr || result.stdout).trim().slice(0, 400);
      throw new Error(detail || `SSM status ${result.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodeId,
      instanceId: entry.instanceId,
      delivery: "manual",
      bundleUrl,
      error: message,
    };
  }

  await updateRegistryAgentVersion(aws, entry, agentVersion);
  return { nodeId, instanceId: entry.instanceId, delivery: "ssm" };
}

async function updateRegistryAgentVersion(
  aws: AwsEnv,
  entry: NodeRegistryEntry,
  agentVersion: string,
): Promise<void> {
  const updated: NodeRegistryEntry = { ...entry, agentVersion };
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(entry.clusterId, entry.nodeId), updated);
}

/** EC2 Instance Connect / SSH fallback steps when SSM is unavailable. */
export function manualUpgradeHint(nodeId: string, bundleUrl: string): string {
  return [
    `  ${nodeId}:`,
    `    curl -fsSL '<presigned-url>' -o ${AGENT_INSTALL_PATH}`,
    `    sudo systemctl restart ${AGENT_SYSTEMD_UNIT}`,
    "",
    "  Connect with EC2 Instance Connect (console) or SSH if the node has port 22 open.",
    `  Presigned URL (15 min): ${bundleUrl}`,
  ].join("\n");
}
