import { setTimeout as sleep } from "node:timers/promises";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  type NodeStatus,
  parseNodeStatus,
  type ServiceState,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { getJson } from "../aws/s3-state";

export interface WatchTarget {
  nodeId: string;
  project: string;
  service: string;
  image: string;
  expectedReplicas: number;
}

export interface WatchResult {
  target: WatchTarget;
  state: ServiceState | "pending";
  ok: boolean;
  message: string;
}

function evaluate(status: NodeStatus | null, target: WatchTarget): WatchResult {
  const svc = status?.services.find(
    (s) => s.project === target.project && s.service === target.service,
  );
  if (!svc) {
    return {
      target,
      state: "pending",
      ok: false,
      message: status ? "not yet reported by the agent" : "no agent status yet",
    };
  }
  if (svc.state === "error") {
    return { target, state: "error", ok: false, message: svc.message || "error" };
  }
  // Converged: every expected replica is running the deployed image.
  const onImage = svc.replicas.filter((r) => r.image === target.image && r.state === "running").length;
  if (svc.runningReplicas >= target.expectedReplicas && onImage >= target.expectedReplicas) {
    return { target, state: "running", ok: true, message: `${onImage}/${target.expectedReplicas} replicas` };
  }
  return {
    target,
    state: svc.state,
    ok: false,
    message: `${onImage}/${target.expectedReplicas} on new image (${svc.runningReplicas} running)`,
  };
}

/**
 * Poll the nodes' status.json until every target service is running the deployed
 * image, any target errors, or the timeout elapses. Returns the final results.
 */
export async function waitForConvergence(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  targets: WatchTarget[],
  timeoutMs: number,
  onTick?: (results: WatchResult[]) => void,
): Promise<WatchResult[]> {
  const deadline = Date.now() + timeoutMs;
  const nodeIds = [...new Set(targets.map((t) => t.nodeId))];
  let results: WatchResult[] = targets.map((target) => evaluate(null, target));

  for (;;) {
    const statusByNode = new Map<string, NodeStatus | null>();
    for (const nodeId of nodeIds) {
      const obj = await getJson(s3, bucket, statusKey(clusterId, nodeId));
      let status: NodeStatus | null = null;
      if (obj) {
        try {
          status = parseNodeStatus(obj.raw);
        } catch {
          status = null;
        }
      }
      statusByNode.set(nodeId, status);
    }

    results = targets.map((target) => evaluate(statusByNode.get(target.nodeId) ?? null, target));
    onTick?.(results);

    if (results.every((r) => r.ok)) return results;
    if (results.some((r) => r.state === "error")) return results;
    if (Date.now() > deadline) return results;

    await sleep(3000);
  }
}
