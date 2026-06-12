import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { describeInstancesById, type Ec2Observation } from "../aws/ec2";
import { ensureNodeIam, ensureSsmManagedPolicyForNode } from "../aws/iam";
import { runShellScriptOnInstances } from "../aws/run-command";
import { CliError } from "../errors";
import { ssmRunBashScript } from "./agent-upgrade";
import { renderCloudWatchInstallScript } from "./cloudwatch";

export type LoggingDelivery = "ssm" | "manual";

export interface InstallLoggingResult {
  nodeId: string;
  instanceId: string | null;
  delivery: LoggingDelivery;
  error?: string;
}

export interface InstallLoggingParams {
  aws: AwsEnv;
  entry: NodeRegistryEntry;
  onProgress?: (text: string) => void;
}

function requireRunningInstance(obs: Ec2Observation, nodeId: string): void {
  if (obs.kind === "running") return;
  const detail =
    obs.kind === "stopped"
      ? "instance is stopped"
      : obs.kind === "transitional"
        ? `instance is ${obs.state}`
        : "instance is gone";
  throw new CliError(`can't install logging on "${nodeId}" — ${detail}`, {
    hint: "start it with `launchpad node resume` or reconcile drift first",
  });
}

/**
 * Bring CloudWatch log shipping to an existing node: update its per-node IAM policy
 * (adds CloudWatch Logs write) and install + start the Amazon CloudWatch Agent over
 * SSM. Idempotent — safe to run repeatedly. The launchpad agent picks up dynamic
 * per-container config on its next tick, so no agent restart is needed.
 */
export async function installLoggingOnNode(p: InstallLoggingParams): Promise<InstallLoggingResult> {
  const { aws, entry } = p;
  const report = p.onProgress ?? (() => {});
  const { nodeId } = entry;

  if (!entry.instanceId) {
    throw new CliError(`node "${nodeId}" has no EC2 instance yet`, {
      hint: "provision it with `launchpad node create` or deploy with auto-create",
    });
  }

  const obs = (await describeInstancesById(aws.ec2, [entry.instanceId])).get(entry.instanceId) ?? {
    kind: "missing" as const,
  };
  requireRunningInstance(obs, nodeId);

  // 1. Update IAM so the node may write its cluster's /launch-pad/* log groups.
  report(`updating IAM for ${nodeId}`);
  await ensureNodeIam(aws.iam, {
    clusterId: entry.clusterId,
    nodeId,
    role: entry.role,
    bucket: aws.bucket,
    region: aws.region,
    accountId: aws.accountId,
  });

  // 2. Install + start the CloudWatch Agent over SSM (install is slower than an
  // agent swap, so allow a longer timeout).
  report(`installing CloudWatch Agent on ${entry.instanceId} via SSM`);
  await ensureSsmManagedPolicyForNode(aws.iam, entry);
  const script = renderCloudWatchInstallScript({
    clusterId: entry.clusterId,
    nodeId,
    role: entry.role,
  });
  try {
    const outcomes = await runShellScriptOnInstances(
      aws.ssm,
      [entry.instanceId],
      ssmRunBashScript(script),
      300_000,
    );
    const result = outcomes[0];
    if (!result) throw new Error("SSM returned no invocation result");
    if (result.status !== "Success") {
      const detail = (result.stderr || result.stdout).trim().slice(0, 400);
      throw new Error(detail || `SSM status ${result.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { nodeId, instanceId: entry.instanceId, delivery: "manual", error: message };
  }

  return { nodeId, instanceId: entry.instanceId, delivery: "ssm" };
}
