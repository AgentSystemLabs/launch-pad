import { generateNodeName, sharesToVcpu } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

export interface Placement {
  nodeId: string;
  replicas: number;
}

/**
 * A cluster node as the capacity scheduler sees it — always an **app** node (the
 * edge never hosts containers, so it never enters the pool). `steady*` and
 * `maxSurge*` follow `checkCapacity`'s convention exactly (steady = Σ
 * cpu×replicas, surge = the single largest `cpu×min(maxSurge, replicas)` per
 * resource) so a placement the planner accepts can never fail deploy's
 * `assertCapacity` pre-flight.
 */
export interface CandidateNode {
  nodeId: string;
  /** total − reserved (shares / MB). */
  allocatableCpu: number;
  allocatableMemory: number;
  /** Demand already committed: other projects' desired.json on this node. */
  steadyCpu: number;
  steadyMemory: number;
  /** Largest single committed rollout surge, per resource. */
  maxSurgeCpu: number;
  maxSurgeMemory: number;
}

/**
 * A synthetic placement target for an **empty-pool bootstrap** — when a deploy
 * needs placement but the cluster has no app node yet. Injecting one of these into
 * the candidate pool lets the normal planner place onto it; `deploy` then
 * auto-creates the real node, **sized to the demand** (so the synthetic's capacity
 * only has to be large enough that `fits` always passes — the real instance type is
 * chosen by `smallestInstanceTypeFor` at provision time).
 */
export function bootstrapCandidateNode(nodeId: string): CandidateNode {
  // Effectively unbounded, but finite (avoids NaN in the score/divide math). Far above
  // any single instance type, so the planner never rejects the bootstrap for capacity —
  // a demand that won't fit any real instance fails later, at sizing, with a clear error.
  const UNBOUNDED = Number.MAX_SAFE_INTEGER;
  return {
    nodeId,
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
  /**
   * Service declares persistent volumes — its data lives on ONE node's disk, so
   * all replicas land on a single node and the placement is STICKY (it never moves
   * off the node it first landed on; see `stickyNodeId`).
   */
  hasVolumes: boolean;
  /**
   * The node a volume-bearing service is already deployed on (from the published
   * footprint), or null on first deploy. Ignored for volume-less services. When the
   * node still exists, the planner MUST keep the service there — moving it would
   * strand the data.
   */
  stickyNodeId: string | null;
}

export interface ClusterServicePlan {
  service: string;
  placements: Placement[];
  /** Full eligible pool considered — deploy registers these for drift-repair parity. */
  pool: string[];
}

export interface ClusterPlanInput {
  /** For error hints only. */
  clusterId: string;
  /** The cluster's app nodes, in listNodeIds (S3-lexicographic) order. */
  nodes: CandidateNode[];
  /** Services to place, in launch-pad.toml declaration order. */
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
 * Thrown when a service's replica can't be placed on any eligible node. A distinct
 * subclass so deploy-side auto-add can catch *only* capacity failures and grow the pool —
 * a different planner error (e.g. a sticky volume node that's full) must NOT trigger
 * node creation.
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
 * Plan every service (declaration order; later services see earlier consumption).
 * Bin-packs by free headroom — spreads replicas and services across empty nodes
 * when possible, stacks on one node only when necessary. Volume-bearing services
 * are single-node and sticky (see {@link ClusterServiceInput.stickyNodeId}).
 * Pure — mutates nothing it's given; throws CliError when a service can't be placed.
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
    const poolIds = tallies.map((t) => t.node.nodeId);
    const placements = s.hasVolumes ? placeVolumeService(tallies, s) : packByCapacity(tallies, s);

    commit(tallies, s, placements);
    plans.push({ service: s.name, placements, pool: poolIds });
  }
  return plans;
}

/**
 * Volume services: ALL replicas on ONE node. If the service is already deployed
 * (sticky node still in the pool) it stays put — its data lives on that node's
 * disk; a full sticky node is a hard error (adding nodes can't move the data).
 * First deploy picks the node with the best headroom that fits all replicas.
 */
function placeVolumeService(tallies: NodeTally[], s: ClusterServiceInput): Placement[] {
  if (s.stickyNodeId !== null) {
    const sticky = tallies.find((t) => t.node.nodeId === s.stickyNodeId);
    if (sticky) {
      if (!fits(sticky, s, s.replicas)) {
        throw new CliError(
          `service "${s.name}" has persistent volumes on node "${s.stickyNodeId}" but the node no longer has capacity for it\n` +
            capacityBreakdownLines([sticky], s).join("\n"),
          {
            hint:
              "free capacity on that node (or resize it: launchpad node resize) — a volume service can't move nodes without stranding its data",
          },
        );
      }
      return [{ nodeId: sticky.node.nodeId, replicas: s.replicas }];
    }
    // Sticky node is gone (destroyed) — the data went with it; place fresh below.
  }
  const best = bestNode(tallies, s, new Map(), s.replicas);
  if (!best) throw noFitError(s, 1, tallies);
  return [{ nodeId: best.node.nodeId, replicas: s.replicas }];
}

/** Replica-at-a-time greedy: each replica lands on the node with the most headroom. */
function packByCapacity(pool: NodeTally[], s: ClusterServiceInput): Placement[] {
  const counts = new Map<string, number>();
  for (let i = 1; i <= s.replicas; i += 1) {
    const best = bestNode(pool, s, counts, 1);
    if (!best) throw noFitError(s, i, pool, counts);
    counts.set(best.node.nodeId, (counts.get(best.node.nodeId) ?? 0) + 1);
  }
  return pool
    .map((t) => ({ nodeId: t.node.nodeId, replicas: counts.get(t.node.nodeId) ?? 0 }))
    .filter((p) => p.replicas > 0);
}

/**
 * A synthetic candidate node sized like the cluster's **largest existing node** (so an
 * auto-added node matches the cluster's instance sizing), or an unbounded bootstrap node
 * when there are none. The real instance size is decided from demand at provision time,
 * like {@link bootstrapCandidateNode}.
 */
export function templateCandidateNode(nodeId: string, existing: CandidateNode[]): CandidateNode {
  if (existing.length === 0) return bootstrapCandidateNode(nodeId);
  return {
    nodeId,
    allocatableCpu: Math.max(...existing.map((n) => n.allocatableCpu)),
    allocatableMemory: Math.max(...existing.map((n) => n.allocatableMemory)),
    steadyCpu: 0,
    steadyMemory: 0,
    maxSurgeCpu: 0,
    maxSurgeMemory: 0,
  };
}

/**
 * Plan cluster placement, **auto-adding app nodes** (each sized like the cluster's existing
 * nodes) when the current pool can't fit the services — instead of erroring "reduce
 * cpu/memory/replicas". Returns the plans plus the synthetic nodes that were added, so the
 * caller can provision them for real (auto-sized to their actual placement).
 *
 * Pure given `opts.rng` (added nodes get generated `<noun>-<verb>-<adverb>` ids).
 * Stops after `maxAdd` additions, then rethrows the planner's
 * {@link CapacityPlacementError}. A non-capacity planner error (e.g. a full sticky
 * volume node) is rethrown immediately — adding nodes can't fix it.
 */
export function planClusterPlacementAutoAdd(
  input: ClusterPlanInput,
  opts: { maxAdd: number; existingNodeIds: string[]; rng?: () => number },
): { plans: ClusterServicePlan[]; added: CandidateNode[] } {
  const nodes = [...input.nodes];
  const added: CandidateNode[] = [];
  const used = new Set(opts.existingNodeIds);

  const addNode = (): void => {
    const id = generateNodeName(used, opts.rng);
    used.add(id);
    const node = templateCandidateNode(id, input.nodes);
    nodes.push({ ...node, nodeId: id });
    added.push({ ...node, nodeId: id });
  };

  for (;;) {
    try {
      return { plans: planClusterPlacement({ ...input, nodes }), added };
    } catch (e) {
      if (e instanceof CapacityPlacementError && added.length < opts.maxAdd) {
        addNode();
        continue;
      }
      throw e;
    }
  }
}
