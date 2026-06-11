import {
  type NodeRegistryEntry,
  nodeRegistryKey,
  nodeUsesElasticIp,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { putJson } from "../aws/s3-state";
import { CliError } from "../errors";
import type { AgentType } from "../provision/agent-bundle";
import type { AmiBootstrapMode } from "../provision/golden-ami";
import { replaceInstance, resumeNode } from "../provision/provision-node";
import type { DriftAction } from "./drift-plan";

export interface ApplyNodeDriftParams {
  aws: AwsEnv;
  /** The node whose EC2 reality drifted from the registry. */
  entry: NodeRegistryEntry;
  /** The action {@link planNodeDrift} decided for it. */
  action: DriftAction;
  /** Agent version to install if the action recreates the instance. */
  agentVersion: string;
  agentType?: AgentType;
  amiId?: string;
  amiBootstrapMode?: AmiBootstrapMode;
  onProgress?: (text: string) => void;
}

/**
 * Carry out one {@link DriftAction} and return the resulting (possibly updated)
 * registry entry. Imperative counterpart to the pure {@link planNodeDrift};
 * shared by `deploy`'s preflight and `node reconcile`.
 */
export async function applyNodeDrift(p: ApplyNodeDriftParams): Promise<NodeRegistryEntry> {
  const { aws, entry, action } = p;
  switch (action.kind) {
    case "noop":
      return entry;

    case "sync": {
      // EC2 is the truth here — the console changed it under us; adopt it.
      const updated: NodeRegistryEntry = {
        ...entry,
        state: "ready",
        publicIp: nodeUsesElasticIp(entry.role) ? (action.publicIp ?? entry.publicIp) : null,
        privateIp: action.privateIp ?? entry.privateIp,
        availabilityZone: action.availabilityZone ?? entry.availabilityZone,
      };
      await putJson(aws.s3, aws.bucket, nodeRegistryKey(entry.clusterId, entry.nodeId), updated);
      return updated;
    }

    case "resume":
      return resumeNode(aws, entry);

    case "recreate":
      return replaceInstance({
        aws,
        node: entry,
        agentVersion: p.agentVersion,
        agentType: p.agentType,
        amiId: p.amiId,
        amiBootstrapMode: p.amiBootstrapMode,
        onProgress: p.onProgress,
      });

    case "blocked":
      throw new CliError(`node "${entry.nodeId}": ${action.reason}`, {
        hint: "fix it in the AWS console, or run `launch-pad node reconcile` once it is stable",
      });
  }
}
