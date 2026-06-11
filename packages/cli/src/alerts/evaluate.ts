import {
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  type NodeState,
  type NodeStatus,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";

export type AlertSeverity = "warning" | "critical";

export type AlertKind = "heartbeat-stale" | "service-unhealthy";

export interface Alert {
  nodeId: string;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  /** For service-unhealthy: the `project/service` key. */
  service?: string;
}

/** Grace period before a node that has NEVER reported status is treated as failed. */
export const DEFAULT_BOOT_GRACE_MS = 10 * 60_000;

/** One node, projected to what the alert heuristic reads: its lifecycle + last status.json. */
export interface AlertNodeInput {
  nodeId: string;
  state: NodeState;
  /** ISO node-creation timestamp — bounds the boot grace for a node with no status yet. */
  createdAt: string;
  status: NodeStatus | null;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1 };

/** States that mean "this node is supposed to be running" — the only ones we alert on. */
function isLiveState(state: NodeState): boolean {
  // `stopped` (paused) is intentional; `terminating`/`terminated` are gone. The rest
  // (`ready`, `provisioning`) bill and should be healthy. A freshly-created node sits at
  // `provisioning` until a drift repair flips it, so we can't require `ready` here.
  return state === "ready" || state === "provisioning";
}

/**
 * Flag things that are actually broken on nodes that are SUPPOSED to be running:
 *
 *  - **heartbeat-stale** — a live node whose agent hasn't reported within `staleMs` (or,
 *    past a boot grace, has never reported). The node may be down, the agent crashed, or
 *    it lost network.
 *  - **service-unhealthy** — a service in the `error` state, or one wanting replicas but
 *    running zero (fully down). Checked only when the heartbeat is fresh (a stale node's
 *    service states are unreliable).
 *
 * Deliberately quiet on the cases that aren't faults: a `stopped` (paused) node's agent is
 * off on purpose, a still-booting node (no status yet, within the boot grace) is given time,
 * and a partially-degraded service (e.g. 2/3 replicas) is usually a transient rollout — none
 * of those alert. Pure; `nowMs`, the staleness threshold, and the boot grace are passed in.
 */
export function evaluateAlerts(
  nodes: AlertNodeInput[],
  nowMs: number,
  opts?: { staleMs?: number; bootGraceMs?: number },
): Alert[] {
  const staleMs = opts?.staleMs ?? HEARTBEAT_STALE_MS;
  const bootGraceMs = opts?.bootGraceMs ?? DEFAULT_BOOT_GRACE_MS;
  const alerts: Alert[] = [];

  for (const n of nodes) {
    // Only nodes that are supposed to be live can be "broken".
    if (!isLiveState(n.state)) continue;

    if (n.status === null) {
      // Never reported — give a freshly-created node its boot window before alerting.
      const ageMs = nowMs - Date.parse(n.createdAt);
      if (Number.isNaN(ageMs) || ageMs <= bootGraceMs) continue;
      alerts.push({
        nodeId: n.nodeId,
        kind: "heartbeat-stale",
        severity: "critical",
        message: `agent has not reported status in ${Math.round(ageMs / 60_000)}m — the node may have failed to come up`,
      });
      continue;
    }

    if (isHeartbeatStale(n.status.lastSeen, nowMs, staleMs)) {
      const ageS = Math.max(0, Math.round((nowMs - Date.parse(n.status.lastSeen)) / 1000));
      alerts.push({
        nodeId: n.nodeId,
        kind: "heartbeat-stale",
        severity: "critical",
        message: `agent heartbeat is stale (last seen ${ageS}s ago) — the node may be down`,
      });
      continue; // a stale node's service states are unreliable
    }

    for (const s of n.status.services) {
      const key = serviceKey(s.project, s.service);
      if (s.state === "error") {
        alerts.push({
          nodeId: n.nodeId,
          kind: "service-unhealthy",
          severity: "critical",
          service: key,
          message: `service ${key} is in error${s.message ? `: ${s.message}` : ""}`,
        });
      } else if (s.desiredReplicas > 0 && s.runningReplicas === 0) {
        alerts.push({
          nodeId: n.nodeId,
          kind: "service-unhealthy",
          severity: "critical",
          service: key,
          message: `service ${key} has 0/${s.desiredReplicas} replicas running`,
        });
      }
    }
  }

  return alerts.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.nodeId.localeCompare(b.nodeId),
  );
}
