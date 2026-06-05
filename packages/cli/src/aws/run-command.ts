import {
  GetCommandInvocationCommand,
  SendCommandCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import { awsErrorName } from "./errors";

export interface ShellCommandResult {
  instanceId: string;
  status: string;
  stdout: string;
  stderr: string;
}

const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function isTerminal(status: string | undefined): boolean {
  return status !== "Pending" && status !== "InProgress" && status !== "Delayed";
}

/**
 * Run a shell script on one or more EC2 instances via SSM `AWS-RunShellScript`.
 * Instances must be registered with SSM (AmazonSSMManagedInstanceCore on the role).
 */
export async function runShellScriptOnInstances(
  ssm: SSMClient,
  instanceIds: string[],
  commands: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ShellCommandResult[]> {
  if (instanceIds.length === 0) return [];

  let commandId: string;
  try {
    const sent = await ssm.send(
      new SendCommandCommand({
        DocumentName: "AWS-RunShellScript",
        InstanceIds: instanceIds,
        Parameters: { commands },
        TimeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      }),
    );
    commandId = sent.Command?.CommandId ?? "";
    if (!commandId) {
      throw new Error("SSM SendCommand returned no CommandId");
    }
  } catch (error) {
    const name = awsErrorName(error);
    if (name === "InvalidInstanceId") {
      throw new Error(
        "instance is not registered with SSM — attach AmazonSSMManagedInstanceCore to the node role, wait a few minutes, or upgrade manually via EC2 Instance Connect",
        { cause: error },
      );
    }
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  const results = new Map<string, ShellCommandResult>();

  while (results.size < instanceIds.length && Date.now() < deadline) {
    await sleep(POLL_MS);
    for (const instanceId of instanceIds) {
      if (results.has(instanceId)) continue;
      try {
        const inv = await ssm.send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
        );
        const status = inv.Status ?? "Unknown";
        if (!isTerminal(status)) continue;
        results.set(instanceId, {
          instanceId,
          status,
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
        });
      } catch (error) {
        const name = awsErrorName(error);
        if (name === "InvocationDoesNotExist") continue;
        throw error;
      }
    }
  }

  if (results.size < instanceIds.length) {
    const pending = instanceIds.filter((id) => !results.has(id));
    throw new Error(`timed out waiting for SSM on: ${pending.join(", ")}`);
  }

  return instanceIds.map((id) => results.get(id)!);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
