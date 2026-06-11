import {
  type NodeRole,
  type ServiceDecl,
  type ServiceSchedule,
  type ServiceTopology,
  sharesToVcpu,
  targetNodes,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

export interface Placement {
  nodeId: string;
  replicas: number;
}

/** Distribute `replicas` round-robin across `nodeIds`; drops nodes that get zero. */
export function distributeReplicas(nodeIds: string[], replicas: number): Placement[] {
  if (nodeIds.length === 0) return [];

  const counts = new Map<string, number>(nodeIds.map((n) => [n, 0]));
  for (let i = 0; i < replicas; i += 1) {
    const node = nodeIds[i % nodeIds.length] as string;
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return [...counts].filter(([, c]) => c > 0).map(([nodeId, replicas]) => ({ nodeId, replicas }));
}

/** Distribute a service's replicas across the nodes it pins explicitly (`node`/`nodes`). */
export function planPlacement(decl: ServiceDecl): Placement[] {
  return distributeReplicas(targetNodes(decl), decl.replicas);
}

/**
 * A cluster node as the capacity scheduler sees it. `steady*` and `maxSurge*`
 * follow `checkCapacity`'s convention exactly (steady = Σ cpu×replicas, surge =
 * the single largest `cpu×min(maxSurge, replicas)` per resource) so a placement
 * the planner accepts can never fail deploy's `assertCapacity` pre-flight.
 */
export interface CandidateNode {
  nodeId: string;
  role: NodeRole;
  /** total − reserved (shares / MB). */
  allocatableCpu: number;
  allocatableMemory: number;
  /** Demand already committed: other projects' desired.json (+ this deploy's pinned seed). */
  steadyCpu: number;
  steadyMemory: number;
  /** Largest single committed rollout surge, per resource. */
  maxSurgeCpu: number;
  maxSurgeMemory: number;
}

/**
 * A synthetic placement target for an **empty-cluster bootstrap** — when a deploy
 * needs cluster auto-placement but the cluster has no app/both node yet. Injecting one
 * of these into the candidate pool lets the normal planner place onto it; `deploy` then
 * auto-creates the real node, **sized to the demand** (so the synthetic's capacity only
 * has to be large enough that `fits` always passes — the real instance type is chosen by
 * `smallestInstanceTypeFor` at provision time). Role `both` so it's eligible for every
 * topology's pool (`["both"]` for co-located, `["app","both"]` otherwise); the actual
 * role is re-inferred from demand (`inferNodeRole`) when the node is created.
 */
export function bootstrapCandidateNode(nodeId: string): CandidateNode {
  // Effectively unbounded, but finite (avoids NaN in the score/divide math). Far above
  // any single instance type, so the planner never rejects the bootstrap for capacity —
  // a demand that won't fit any real instance fails later, at sizing, with a clear error.
  const UNBOUNDED = Number.MAX_SAFE_INTEGER;
  return {
    nodeId,
    role: "both",
    allocatableCpu: UNBOUNDED,
    allocatableMemory: UNBOUNDED,
    steadyCpu: 0,
    steadyMemory: 0,
    maxSurgeCpu: 0,
    maxSurgeMemory: 0,
  };
}

/** The slice of a `ServiceDecl` the cluster planner needs (kept plain for tests). */
export interface ClusterServiceInput {
  name: string;
  replicas: number;
  /** Per-replica demand (shares / MB). */
  cpu: number;
  memory: number;
  maxSurge: number;
  isWeb: boolean;
  explicitEdge: string | null;
  schedule: ServiceSchedule;
  topology: ServiceTopology;
}

export interface ClusterServicePlan {
  service: string;
  placements: Placement[];
  /** Resolved `ingress.edge` tri-state input: null = co-located Caddy / worker. */
  edge: string | null;
  /** Full eligible pool considered — deploy registers these for drift-repair parity. */
  pool: string[];
  schedule: ServiceSchedule;
  topology: ServiceTopology;
}

export interface ClusterPlanInput {
  /** For error hints only. */
  clusterId: string;
  clusterDefaultEdge: string | null;
  /** ALL cluster nodes, in listNodeIds (S3-lexicographic) order — order is load-bearing for "even". */
  nodes: CandidateNode[];
  /** Cluster-placed services, in launch-pad.toml declaration order. */
  services: ClusterServiceInput[];
}

/** Mutable per-node tally while planning; mirrors capacityDemands math in deploy. */
interface NodeTally {
  node: CandidateNode;
  steadyCpu: number;
  steadyMemory: number;
  maxSurgeCpu: number;
  maxSurgeMemory: number;
}

function fits(t: NodeTally, s: ClusterServiceInput, replicasHere: number): boolean {
  const surgeCpu = Math.max(t.maxSurgeCpu, s.cpu * Math.min(s.maxSurge, replicasHere));
  const surgeMemory = Math.max(t.maxSurgeMemory, s.memory * Math.min(s.maxSurge, replicasHere));
  return (
    t.steadyCpu + s.cpu * replicasHere + surgeCpu <= t.node.allocatableCpu &&
    t.steadyMemory + s.memory * replicasHere + surgeMemory <= t.node.allocatableMemory
  );
}

/**
 * Free fraction of the binding resource after placing `replicasHere` replicas —
 * higher is better. Steady-state only: surge gates feasibility (in `fits`), not
 * preference, so one mid-roll spike doesn't repel all placements from a node.
 */
function scoreAfter(t: NodeTally, s: ClusterServiceInput, replicasHere: number): number {
  const freeCpu = t.node.allocatableCpu - (t.steadyCpu + s.cpu * replicasHere);
  const freeMemory = t.node.allocatableMemory - (t.steadyMemory + s.memory * replicasHere);
  return Math.min(freeCpu / t.node.allocatableCpu, freeMemory / t.node.allocatableMemory);
}

function freeCpuAfter(t: NodeTally, s: ClusterServiceInput, replicasHere: number): number {
  return t.node.allocatableCpu - (t.steadyCpu + s.cpu * replicasHere);
}

function freeMemoryAfter(t: NodeTally, s: ClusterServiceInput, replicasHere: number): number {
  return t.node.allocatableMemory - (t.steadyMemory + s.memory * replicasHere);
}

/** Pick the feasible node with the most post-placement headroom; null when none fits. */
function bestNode(
  tallies: NodeTally[],
  s: ClusterServiceInput,
  counts: Map<string, number>,
  addReplicas: number,
): NodeTally | null {
  let best: NodeTally | null = null;
  for (const t of tallies) {
    const replicasHere = (counts.get(t.node.nodeId) ?? 0) + addReplicas;
    if (!fits(t, s, replicasHere)) continue;
    if (best === null) {
      best = t;
      continue;
    }
    const bestHere = (counts.get(best.node.nodeId) ?? 0) + addReplicas;
    const d = scoreAfter(t, s, replicasHere) - scoreAfter(best, s, bestHere);
    if (d > 0) best = t;
    else if (d === 0) {
      const dCpu = freeCpuAfter(t, s, replicasHere) - freeCpuAfter(best, s, bestHere);
      const dMem = freeMemoryAfter(t, s, replicasHere) - freeMemoryAfter(best, s, bestHere);
      if (dCpu > 0 || (dCpu === 0 && dMem > 0)) best = t;
      else if (dCpu === 0 && dMem === 0 && t.node.nodeId < best.node.nodeId) best = t;
    }
  }
  return best;
}

/** One human-readable line per node explaining why a capacity placement failed. */
export function capacityBreakdownLines(
  tallies: Array<Pick<NodeTally, "node" | "steadyCpu" | "steadyMemory">>,
  s: Pick<ClusterServiceInput, "cpu" | "memory" | "maxSurge">,
  /** Replicas of THIS service already placed per node in the current greedy pass. */
  counts: Map<string, number> = new Map(),
): string[] {
  return tallies.map((t) => {
    const placed = counts.get(t.node.nodeId) ?? 0;
    const freeCpu = Math.max(0, t.node.allocatableCpu - t.steadyCpu - s.cpu * placed);
    const freeMemory = Math.max(0, t.node.allocatableMemory - t.steadyMemory - s.memory * placed);
    return (
      `  ${t.node.nodeId}  free ${sharesToVcpu(freeCpu)} vCPU · ${freeMemory} MB` +
      `   needs ${sharesToVcpu(s.cpu)} vCPU · ${s.memory} MB` +
      ` (+${sharesToVcpu(s.cpu)} vCPU · ${s.memory} MB rollout surge)`
    );
  });
}

/**
 * Thrown by the capacity scheduler when a service's replica can't be placed on any
 * eligible node. A distinct subclass so the deploy-side auto-add (`planClusterPlacementAutoAdd`)
 * can catch *only* capacity failures and grow the pool — a different planner error (e.g.
 * "split needs an edge") must NOT trigger node creation, since adding nodes can't fix it.
 */
export class CapacityPlacementError extends CliError {}

function noFitError(
  service: ClusterServiceInput,
  replicaIndex: number,
  tallies: NodeTally[],
  counts: Map<string, number> = new Map(),
): CapacityPlacementError {
  return new CapacityPlacementError(
    `service "${service.name}" does not fit: replica ${replicaIndex} of ${service.replicas} has no eligible node with capacity\n` +
      capacityBreakdownLines(tallies, service, counts).join("\n"),
    { hint: "free capacity on a node, add an app node to the cluster, or reduce cpu/memory/replicas" },
  );
}

/** Commit a service's final per-node counts into the tallies for the next service. */
function commit(tallies: NodeTally[], s: ClusterServiceInput, placements: Placement[]): void {
  for (const p of placements) {
    const t = tallies.find((x) => x.node.nodeId === p.nodeId);
    if (!t) continue;
    t.steadyCpu += s.cpu * p.replicas;
    t.steadyMemory += s.memory * p.replicas;
    t.maxSurgeCpu = Math.max(t.maxSurgeCpu, s.cpu * Math.min(s.maxSurge, p.replicas));
    t.maxSurgeMemory = Math.max(t.maxSurgeMemory, s.memory * Math.min(s.maxSurge, p.replicas));
  }
}

/**
 * Plan every cluster-placed service (declaration order; later services see
 * earlier consumption). Pure — mutates nothing it's given; throws CliError when
 * a service can't be placed.
 */
export function planClusterPlacement(input: ClusterPlanInput): ClusterServicePlan[] {
  const tallies: NodeTally[] = input.nodes.map((node) => ({
    node,
    steadyCpu: node.steadyCpu,
    steadyMemory: node.steadyMemory,
    maxSurgeCpu: node.maxSurgeCpu,
    maxSurgeMemory: node.maxSurgeMemory,
  }));

  const plans: ClusterServicePlan[] = [];
  for (const s of input.services) {
    // 1. Eligible pool (input order preserved — "even" depends on it).
    const wantedRoles: NodeRole[] = s.topology === "co-located" ? ["both"] : ["app", "both"];
    const pool = tallies.filter((t) => wantedRoles.includes(t.node.role));
    if (s.topology === "co-located" && pool.length === 0) {
      throw new CliError(
        `service "${s.name}" has topology = "co-located" but cluster "${input.clusterId}" has no both-role node to host it`,
        { hint: `create one: launch-pad node create <name> --cluster ${input.clusterId} --role both` },
      );
    }

    // 2. Edge (tri-state input for ingress.edge).
    let edge: string | null = null;
    if (s.isWeb && s.topology !== "co-located") {
      edge = s.explicitEdge ?? input.clusterDefaultEdge;
      if (s.topology === "split" && edge === null) {
        throw new CliError(`service "${s.name}" has topology = "split" but no edge fronts it`, {
          hint:
            `add edge = "<edge-node-id>" to the service, or set the cluster default: ` +
            `launch-pad cluster set-edge ${input.clusterId} <edge-node-id>`,
        });
      }
      // "auto" keys this on POOL size (not placed count) — matches the legacy deploy check.
      if (s.topology === "auto" && pool.length > 1 && edge === null) {
        throw new CliError(
          `service "${s.name}" spans ${pool.length} nodes but has no edge to load-balance them`,
          { hint: `set the cluster's edge: launch-pad cluster set-edge ${input.clusterId} <edge-node-id>` },
        );
      }
    }

    // 3. Distribution.
    const poolIds = pool.map((t) => t.node.nodeId);
    let placements: Placement[];
    if (s.topology === "co-located") {
      placements =
        s.schedule === "capacity"
          ? [{ nodeId: pickCoLocated(pool, s).node.nodeId, replicas: s.replicas }]
          : [{ nodeId: poolIds[0] as string, replicas: s.replicas }];
    } else if (s.schedule === "even") {
      placements = distributeReplicas(poolIds, s.replicas);
    } else {
      placements = packByCapacity(pool, s);
    }

    commit(tallies, s, placements);
    plans.push({
      service: s.name,
      placements,
      edge,
      pool: poolIds,
      schedule: s.schedule,
      topology: s.topology,
    });
  }
  return plans;
}

/** co-located + capacity: the single both-node with the best headroom that fits ALL replicas. */
function pickCoLocated(pool: NodeTally[], s: ClusterServiceInput): NodeTally {
  const best = bestNode(pool, s, new Map(), s.replicas);
  if (!best) throw noFitError(s, 1, pool);
  return best;
}

/** capacity, replica-at-a-time greedy: each replica lands on the node with the most headroom. */
function packByCapacity(pool: NodeTally[], s: ClusterServiceInput): Placement[] {
  const counts = new Map<string, number>();
  for (let i = 1; i <= s.replicas; i += 1) {
    const best = bestNode(pool, s, counts, 1);
    if (!best) throw noFitError(s, i, pool, counts);
    counts.set(best.node.nodeId, (counts.get(best.node.nodeId) ?? 0) + 1);
  }
  // Pool order, zero-count nodes dropped — same output shape as distributeReplicas.
  return pool
    .map((t) => ({ nodeId: t.node.nodeId, replicas: counts.get(t.node.nodeId) ?? 0 }))
    .filter((p) => p.replicas > 0);
}

/** The lowest unused `app-<n>` id, given the ids already in the cluster (any role). */
export function nextAppNodeId(usedIds: Iterable<string>): string {
  const used = new Set(usedIds);
  for (let n = 1; ; n += 1) {
    const id = `app-${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * A synthetic candidate node sized like the cluster's **largest existing node** (so an
 * auto-added node matches the cluster's instance sizing), or an unbounded bootstrap node
 * when there are none. Role `both` (eligible for every topology pool); the real role +
 * instance size are decided from demand at provision time, like {@link bootstrapCandidateNode}.
 */
export function templateCandidateNode(nodeId: string, existing: CandidateNode[]): CandidateNode {
  if (existing.length === 0) return bootstrapCandidateNode(nodeId);
  return {
    nodeId,
    role: "both",
    allocatableCpu: Math.max(...existing.map((n) => n.allocatableCpu)),
    allocatableMemory: Math.max(...existing.map((n) => n.allocatableMemory)),
    steadyCpu: 0,
    steadyMemory: 0,
    maxSurgeCpu: 0,
    maxSurgeMemory: 0,
  };
}

/**
 * Recompute each node's peak load (steady + largest single surge) from a finished plan and
 * report whether ANY node exceeds its allocatable capacity. Mirrors `commit` + `fits`, so a
 * placement this returns false for also passes the deploy capacity admission. Needed because
 * the `even`/`auto` distributor round-robins WITHOUT a capacity check (only `capacity` packs
 * with one) — this is how auto-add notices an even spread that overflows.
 */
function placementOverCapacity(
  nodes: CandidateNode[],
  services: ClusterServiceInput[],
  plans: ClusterServicePlan[],
): boolean {
  const byName = new Map(services.map((s) => [s.name, s]));
  const tally = new Map(
    nodes.map((n) => [
      n.nodeId,
      { steadyCpu: n.steadyCpu, steadyMemory: n.steadyMemory, maxSurgeCpu: n.maxSurgeCpu, maxSurgeMemory: n.maxSurgeMemory },
    ]),
  );
  for (const plan of plans) {
    const s = byName.get(plan.service);
    if (!s) continue;
    for (const p of plan.placements) {
      const t = tally.get(p.nodeId);
      if (!t) continue;
      t.steadyCpu += s.cpu * p.replicas;
      t.steadyMemory += s.memory * p.replicas;
      t.maxSurgeCpu = Math.max(t.maxSurgeCpu, s.cpu * Math.min(s.maxSurge, p.replicas));
      t.maxSurgeMemory = Math.max(t.maxSurgeMemory, s.memory * Math.min(s.maxSurge, p.replicas));
    }
  }
  for (const n of nodes) {
    const t = tally.get(n.nodeId);
    if (!t) continue;
    if (t.steadyCpu + t.maxSurgeCpu > n.allocatableCpu) return true;
    if (t.steadyMemory + t.maxSurgeMemory > n.allocatableMemory) return true;
  }
  return false;
}

/**
 * Plan cluster placement, **auto-adding app nodes** (each sized like the cluster's existing
 * nodes) when the current pool can't fit the services — instead of erroring "reduce
 * cpu/memory/replicas". Returns the plans plus the synthetic nodes that were added, so the
 * caller can provision them for real (auto-sized to their actual placement). Handles both
 * schedules: a `capacity` overflow throws inside the planner (caught here), while an `even`
 * overflow only shows up in the finished plan (detected by {@link placementOverCapacity}).
 *
 * Pure. Stops after `maxAdd` additions: a `capacity` overflow then rethrows the planner's
 * {@link CapacityPlacementError}; an `even` overflow returns the (over-capacity) plan so the
 * caller's authoritative admission check produces the detailed per-node error. A non-capacity
 * planner error (e.g. "split needs an edge") is rethrown immediately — adding nodes can't fix it.
 */
export function planClusterPlacementAutoAdd(
  input: ClusterPlanInput,
  opts: { maxAdd: number; existingNodeIds: string[] },
): { plans: ClusterServicePlan[]; added: CandidateNode[] } {
  const nodes = [...input.nodes];
  const added: CandidateNode[] = [];
  const used = new Set(opts.existingNodeIds);

  const addNode = (): void => {
    const id = nextAppNodeId(used);
    used.add(id);
    // Size from the ORIGINAL real pool so every added node matches the cluster's sizing.
    const node = templateCandidateNode(id, input.nodes);
    nodes.push({ ...node, nodeId: id });
    added.push({ ...node, nodeId: id });
  };

  for (;;) {
    let plans: ClusterServicePlan[];
    try {
      plans = planClusterPlacement({ ...input, nodes });
    } catch (e) {
      if (e instanceof CapacityPlacementError && added.length < opts.maxAdd) {
        addNode();
        continue;
      }
      throw e;
    }
    if (placementOverCapacity(nodes, input.services, plans) && added.length < opts.maxAdd) {
      addNode();
      continue;
    }
    return { plans, added };
  }
}
