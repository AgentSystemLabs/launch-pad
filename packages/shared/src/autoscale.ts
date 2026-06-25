/**
 * Reactive node-pool autoscaling.
 *
 * The policy is **declarative** and stored in `cluster.json` (`autoscale` field);
 * `launchpad autoscale run` is one *reconcile pass* — read the policy, observe the
 * live pool (registry + each node's `status.json` host sample), decide ONE action
 * (scale-out / scale-in / none), apply it, exit. There is no daemon: users cron the
 * command (or run it in CI), matching the no-control-plane design.
 *
 * The planner here is pure and heavily tested; everything side-effecting (EC2,
 * rebalance, teardown) lives in the CLI command.
 */

import { z } from "zod";
import { lookupInstanceCapacity } from "./capacity";
import { generateNodeName } from "./node-names";
import { nodeHostsContainers } from "./node-role";
import type { NodeRole } from "./registry";

/**
 * A status.json host sample older than this is ignored (treated as "no metrics") —
 * the agent refreshes it every stats interval (60s default) and re-publishes status
 * at least every liveness heartbeat, so 5 minutes means "several missed beats".
 */
export const AUTOSCALE_SAMPLE_STALE_MS = 5 * 60_000;

/** Declarative autoscaling policy, persisted in `cluster.json` (`autoscale`). */
export const AutoscalePolicySchema = z
  .object({
    // The 100-node ceiling is a spend-typo guard ("--min 100" vs "--min 10"), not a
    // scalability claim — the policy document is the spend lever for a --yes cron.
    /** Hard floor: `autoscale run` adds nodes (ignoring cooldown) while the pool is smaller. */
    minNodes: z.number().int().min(1).max(100),
    /** Hard ceiling: utilization can never grow the pool past this. */
    maxNodes: z.number().int().min(1).max(100),
    /** Scale OUT when average pool CPU *or* memory utilization reaches this %. */
    scaleOutPercent: z.number().min(1).max(100).default(80),
    /** Scale IN when EVERY pool node's CPU *and* memory utilization is below this %. */
    scaleInPercent: z.number().min(0).max(99).default(30),
    /** Minimum seconds between utilization-driven actions (the minNodes floor ignores it). */
    cooldownSeconds: z.number().int().min(0).default(300),
    /** State, not policy: ISO time of the last action `autoscale run` applied. */
    lastScaleAt: z.string().nullable().default(null),
  })
  .strict()
  .refine((p) => p.maxNodes >= p.minNodes, { message: "maxNodes must be >= minNodes" })
  .refine((p) => p.scaleInPercent < p.scaleOutPercent, {
    message: "scaleInPercent must be below scaleOutPercent (thrash guard)",
  });

export type AutoscalePolicy = z.infer<typeof AutoscalePolicySchema>;

export function parseAutoscalePolicy(input: unknown): AutoscalePolicy {
  return AutoscalePolicySchema.parse(input);
}

/** A node's committed (reserved) footprint + capacity, for scale-in feasibility. */
export interface AutoscaleNodeReservation {
  /** Sum of desired.json steady demand on this node (replica-multiplied), in shares / MB. */
  steadyCpu: number;
  steadyMemory: number;
  /** Largest single-service rollout surge on this node. */
  surgeCpu: number;
  surgeMemory: number;
  /** Capacity minus host reservation. */
  allocatableCpu: number;
  allocatableMemory: number;
}

/** One node as the autoscaler observes it (registry entry + status.json host sample). */
export interface AutoscaleNodeObservation {
  nodeId: string;
  /** Registry role. Only container-hosting nodes join the pool (`app` or legacy `both`). */
  role: NodeRole;
  /**
   * Registry state. Down states ("stopped" / "terminating" / "terminated") leave the
   * pool; "ready" AND "provisioning" count — a just-added node must occupy its pool
   * slot while it boots or the next pass would scale out again (drift-plan semantics:
   * anything not explicitly down means "should be up").
   */
  state: string;
  /** Never pick as a scale-in victim (dedicated edge, the cluster's default edge, …). */
  protected?: boolean;
  /**
   * Provisioning mode. External (BYOS) nodes are real capacity — they count toward
   * pool size / minNodes / utilization — but are NEVER drained as scale-in victims
   * (the autoscaler doesn't own the operator's host). Defaults to "ec2".
   */
  provisioning?: "ec2" | "external";
  /** Host CPU busy % from the node's latest status.json sample, or null when absent/stale. */
  cpuPercent: number | null;
  /** Host memory used % from the node's latest status.json sample, or null when absent/stale. */
  memoryPercent: number | null;
  /**
   * Committed reservations + capacity. When provided, a scale-in victim is only
   * proposed if the surviving pool can absorb its reserved footprint — utilization
   * alone can say "cold" while the admission check (publishDesired) would refuse the
   * consolidation. Omitted ⇒ utilization-only (the admission check still backstops).
   */
  reserved?: AutoscaleNodeReservation;
}

export type AutoscaleDecision =
  | { action: "none"; reason: string }
  | { action: "scale-out"; reason: string }
  | { action: "scale-in"; victim: string; reason: string };

const fmt = (n: number): string => `${Math.round(n)}%`;

/**
 * Decide the single next action for the pool. Deliberately conservative:
 * one action per pass, cooldown between utilization-driven actions, and scale-in
 * requires *fresh metrics from every pool node* — a node we can't see is assumed busy.
 */
export function planAutoscale(input: {
  policy: AutoscalePolicy;
  nodes: AutoscaleNodeObservation[];
  nowMs: number;
}): AutoscaleDecision {
  const { policy, nodes, nowMs } = input;
  const DOWN_STATES = new Set(["stopped", "terminating", "terminated"]);
  const pool = nodes.filter((n) => nodeHostsContainers(n.role) && !DOWN_STATES.has(n.state));

  // Hard floor first — "maintain N nodes" must hold even mid-cooldown.
  if (pool.length < policy.minNodes) {
    return {
      action: "scale-out",
      reason: `pool has ${pool.length} node(s), below minNodes=${policy.minNodes}`,
    };
  }

  const lastScaleMs = policy.lastScaleAt === null ? Number.NaN : Date.parse(policy.lastScaleAt);
  if (!Number.isNaN(lastScaleMs) && nowMs - lastScaleMs < policy.cooldownSeconds * 1000) {
    const left = Math.ceil((policy.cooldownSeconds * 1000 - (nowMs - lastScaleMs)) / 1000);
    return { action: "none", reason: `in cooldown for another ${left}s` };
  }

  const fresh = pool.filter((n) => n.cpuPercent !== null && n.memoryPercent !== null);
  if (fresh.length === 0) {
    return { action: "none", reason: "no pool node is reporting host metrics yet" };
  }

  const avgCpu = fresh.reduce((s, n) => s + (n.cpuPercent as number), 0) / fresh.length;
  const avgMemory = fresh.reduce((s, n) => s + (n.memoryPercent as number), 0) / fresh.length;

  if (avgCpu >= policy.scaleOutPercent || avgMemory >= policy.scaleOutPercent) {
    if (pool.length >= policy.maxNodes) {
      return {
        action: "none",
        reason: `pool is hot (cpu ${fmt(avgCpu)}, memory ${fmt(avgMemory)}) but already at maxNodes=${policy.maxNodes}`,
      };
    }
    return {
      action: "scale-out",
      reason: `average utilization (cpu ${fmt(avgCpu)}, memory ${fmt(avgMemory)}) ≥ ${policy.scaleOutPercent}%`,
    };
  }

  const everyNodeCold =
    fresh.length === pool.length &&
    pool.every(
      (n) =>
        (n.cpuPercent as number) < policy.scaleInPercent &&
        (n.memoryPercent as number) < policy.scaleInPercent,
    );
  if (pool.length > policy.minNodes && everyNodeCold) {
    const candidates = pool.filter(
      (n) => n.protected !== true && (n.provisioning ?? "ec2") !== "external",
    );
    if (candidates.length === 0) {
      return { action: "none", reason: "pool is cold but every node is protected (edge/default-edge)" };
    }
    const load = (n: AutoscaleNodeObservation): number =>
      Math.max(n.cpuPercent as number, n.memoryPercent as number);
    const ordered = [...candidates].sort(
      (a, b) => load(a) - load(b) || b.nodeId.localeCompare(a.nodeId),
    );
    // Reservation feasibility: the coldest node may still host a footprint the
    // survivors can't hold by RESERVATION — the drain's publish would then fail the
    // capacity admission check. Pick the least-utilized victim whose footprint the
    // survivors can absorb; refuse cleanly when none can.
    const victim = ordered.find((v) => survivorsCanAbsorb(v, pool));
    if (victim === undefined) {
      return {
        action: "none",
        reason: "pool is cold but the surviving nodes can't absorb any drainable node's reserved footprint",
      };
    }
    return {
      action: "scale-in",
      victim: victim.nodeId,
      reason: `every node is below ${policy.scaleInPercent}% — draining the least-utilized (${victim.nodeId})`,
    };
  }

  return {
    action: "none",
    reason: `utilization is in range (cpu ${fmt(avgCpu)}, memory ${fmt(avgMemory)})`,
  };
}

/**
 * Aggregate feasibility of draining `victim` onto the rest of the pool: the survivors'
 * combined allocatable must hold their own steady demand, the victim's steady demand,
 * and the pool's largest single surge (a node rolls one service at a time). Aggregate
 * is EXACT for the common single-survivor case and conservative-enough for small pools;
 * the publish-time admission check (assertCapacity) remains the per-node backstop.
 * Missing reservation data (victim's or any survivor's) skips the check — utilization-only.
 */
function survivorsCanAbsorb(
  victim: AutoscaleNodeObservation,
  pool: AutoscaleNodeObservation[],
): boolean {
  if (victim.reserved === undefined) return true;
  const survivors = pool.filter((n) => n.nodeId !== victim.nodeId);
  if (survivors.some((n) => n.reserved === undefined)) return true;
  const sum = (f: (r: AutoscaleNodeReservation) => number): number =>
    survivors.reduce((acc, n) => acc + f(n.reserved as AutoscaleNodeReservation), 0);
  const maxSurge = (f: (r: AutoscaleNodeReservation) => number): number =>
    Math.max(f(victim.reserved as AutoscaleNodeReservation), ...survivors.map((n) => f(n.reserved as AutoscaleNodeReservation)));
  const cpuOk =
    sum((r) => r.allocatableCpu) >=
    sum((r) => r.steadyCpu) + victim.reserved.steadyCpu + maxSurge((r) => r.surgeCpu);
  const memoryOk =
    sum((r) => r.allocatableMemory) >=
    sum((r) => r.steadyMemory) + victim.reserved.steadyMemory + maxSurge((r) => r.surgeMemory);
  return cpuOk && memoryOk;
}

export interface ScaleOutNodeSpec {
  nodeId: string;
  role: "app";
  instanceType: string;
  /** The dedicated edge fronting the new app node. */
  edgeNodeId: string;
}

/**
 * What node a scale-out should create: a generated `<noun>-<verb>-<adverb>` id
 * (mirrors deploy's auto-add naming), sized like the largest node already in the
 * pool (floor t3.small), behind the cluster's dedicated edge. Pass `rng` for a
 * deterministic name in tests.
 */
export function scaleOutNodeSpec(input: {
  existingNodeIds: string[];
  pool: Array<{ nodeId: string; instanceType: string }>;
  defaultEdge: string;
  rng?: () => number;
}): ScaleOutNodeSpec {
  const nodeId = generateNodeName(input.existingNodeIds, input.rng);
  let instanceType = "t3.small";
  let best = lookupInstanceCapacity(instanceType);
  for (const n of input.pool) {
    const cap = lookupInstanceCapacity(n.instanceType);
    if (!cap) continue;
    if (
      !best ||
      cap.totalCpu > best.totalCpu ||
      (cap.totalCpu === best.totalCpu && cap.totalMemory > best.totalMemory)
    ) {
      best = cap;
      instanceType = n.instanceType;
    }
  }
  return {
    nodeId,
    role: "app",
    instanceType,
    edgeNodeId: input.defaultEdge,
  };
}
