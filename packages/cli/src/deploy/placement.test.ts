import { NODE_ID_REGEX } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { CliError } from "../errors";
import {
  bootstrapCandidateNode,
  type CandidateNode,
  CapacityPlacementError,
  type ClusterServiceInput,
  planClusterPlacement,
  planClusterPlacementAutoAdd,
  templateCandidateNode,
} from "./placement";

/** A candidate with 2 vCPU / 2048 MB allocatable and nothing running, unless overridden. */
function cnode(nodeId: string, over: Partial<CandidateNode> = {}): CandidateNode {
  return {
    nodeId,
    allocatableCpu: 2048,
    allocatableMemory: 2048,
    steadyCpu: 0,
    steadyMemory: 0,
    maxSurgeCpu: 0,
    maxSurgeMemory: 0,
    ...over,
  };
}

function svc(over: Partial<ClusterServiceInput> = {}): ClusterServiceInput {
  return {
    name: "web",
    replicas: 1,
    cpu: 256,
    memory: 256,
    maxSurge: 1,
    isWeb: true,
    hasVolumes: false,
    stickyNodeId: null,
    ...over,
  };
}

function plan(nodes: CandidateNode[], services: ClusterServiceInput[]) {
  return planClusterPlacement({ clusterId: "lower", nodes, services });
}

describe("bootstrapCandidateNode (empty-cluster bootstrap)", () => {
  it("is an empty app candidate with the given id", () => {
    const n = bootstrapCandidateNode("app-1");
    expect(n.nodeId).toBe("app-1");
    expect(n.steadyCpu).toBe(0);
    expect(n.steadyMemory).toBe(0);
    expect(n.maxSurgeCpu).toBe(0);
    expect(n.maxSurgeMemory).toBe(0);
  });

  it("has enough capacity that the planner places a large demand onto it", () => {
    const n = bootstrapCandidateNode("app-1");
    // A worker the largest real instance couldn't hold still fits the synthetic node —
    // the real instance is auto-sized to the demand at provision time, not here.
    const [p] = plan([n], [svc({ isWeb: false, cpu: 8192, memory: 65536, replicas: 4 })]);
    expect(p?.placements).toEqual([{ nodeId: "app-1", replicas: 4 }]);
  });
});

describe("templateCandidateNode", () => {
  it("sizes a new node like the cluster's largest existing node (zero demand)", () => {
    const existing = [cnode("a", { allocatableCpu: 1024, allocatableMemory: 2048 }), cnode("b")];
    const t = templateCandidateNode("app-2", existing);
    expect(t.allocatableCpu).toBe(2048); // max(1024, 2048)
    expect(t.allocatableMemory).toBe(2048);
    expect(t.steadyCpu).toBe(0);
    expect(t.maxSurgeCpu).toBe(0);
  });
  it("falls back to an unbounded bootstrap node when there are no existing nodes", () => {
    expect(templateCandidateNode("app-1", []).allocatableCpu).toBe(bootstrapCandidateNode("app-1").allocatableCpu);
  });
});

describe("planClusterPlacementAutoAdd", () => {
  const input = (nodes: CandidateNode[], services: ClusterServiceInput[]) => ({
    clusterId: "lower",
    nodes,
    services,
  });

  it("adds no node when the existing pool already fits", () => {
    const nodes = [cnode("a", { allocatableCpu: 4096, allocatableMemory: 4096 })];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ isWeb: false, replicas: 2 })]),
      { maxAdd: 8, existingNodeIds: ["a"] },
    );
    expect(added).toEqual([]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 2 }]);
  });

  it("auto-adds nodes until every replica fits", () => {
    const nodes = [cnode("a", { allocatableCpu: 512, allocatableMemory: 512 })];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ isWeb: false, cpu: 256, memory: 256, replicas: 3 })]),
      { maxAdd: 8, existingNodeIds: ["a"] },
    );
    const total = plans[0]!.placements.reduce((n, p) => n + p.replicas, 0);
    expect(total).toBe(3);
    expect(added.length).toBeGreaterThan(0);
    // Added nodes get generated names that are valid node ids and collide with nothing.
    const ids = added.map((n) => n.nodeId);
    for (const id of ids) expect(id).toMatch(NODE_ID_REGEX);
    expect(new Set([...ids, "a"]).size).toBe(ids.length + 1);
  });

  it("auto-adds when spread replicas overflow the pool", () => {
    const nodes = [
      cnode("a", { allocatableCpu: 512, allocatableMemory: 512 }),
      cnode("b", { allocatableCpu: 512, allocatableMemory: 512 }),
    ];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ isWeb: false, cpu: 256, memory: 256, replicas: 4 })]),
      { maxAdd: 8, existingNodeIds: ["a", "b"] },
    );
    expect(added.length).toBeGreaterThan(0);
    for (const p of plans[0]!.placements) {
      expect(p.replicas).toBeLessThanOrEqual(1);
    }
  });

  it("rethrows a capacity error when maxAdd is 0", () => {
    const nodes = [cnode("a", { allocatableCpu: 256, allocatableMemory: 256 })];
    expect(() =>
      planClusterPlacementAutoAdd(
        input(nodes, [svc({ isWeb: false, cpu: 256, memory: 256, replicas: 3 })]),
        { maxAdd: 0, existingNodeIds: ["a"] },
      ),
    ).toThrow(CapacityPlacementError);
  });

  it("rethrows a NON-capacity planner error immediately (adding nodes won't fix a full sticky volume node)", () => {
    // The volume service is stuck on "a" which is too small for it — auto-add must NOT
    // grow the pool (the data can't move), it must surface the sticky-node error as-is.
    const nodes = [cnode("a", { allocatableCpu: 256, allocatableMemory: 256 })];
    expect(() =>
      planClusterPlacementAutoAdd(
        input(nodes, [svc({ isWeb: false, hasVolumes: true, stickyNodeId: "a", cpu: 512, memory: 512 })]),
        { maxAdd: 8, existingNodeIds: ["a"] },
      ),
    ).toThrow(/no longer has capacity/);
  });

  it("packs multi-service deploys onto free nodes without auto-adding", () => {
    const nodes = [
      cnode("auth-example-1", { steadyCpu: 1024, steadyMemory: 1024, allocatableCpu: 1792, allocatableMemory: 1536 }),
      cnode("auth-example-node", { allocatableCpu: 1792, allocatableMemory: 1536 }),
      cnode("biggie-smalls", { allocatableCpu: 1792, allocatableMemory: 7680 }),
    ];
    const services = ["auth", "portal", "notes", "chat"].map((name) =>
      svc({ name, cpu: 256, memory: 256, replicas: 1 }),
    );
    const { plans, added } = planClusterPlacementAutoAdd(input(nodes, services), {
      maxAdd: 4,
      existingNodeIds: nodes.map((n) => n.nodeId),
    });
    expect(added).toEqual([]);
    expect(plans).toHaveLength(4);
    const byNode = new Map<string, string[]>();
    for (const p of plans) {
      for (const pl of p.placements) {
        const list = byNode.get(pl.nodeId) ?? [];
        list.push(p.service);
        byNode.set(pl.nodeId, list);
      }
    }
    // Nothing lands on the prod-loaded node — free nodes absorb the footprint.
    expect(byNode.has("auth-example-1")).toBe(false);
    expect(byNode.get("auth-example-node")?.length).toBeGreaterThan(0);
    expect(byNode.get("biggie-smalls")?.length).toBeGreaterThan(0);
  });
});

describe("planClusterPlacement: pool", () => {
  it("registers the full eligible pool even for nodes that receive zero replicas", () => {
    const nodes = [cnode("a"), cnode("b")];
    const [p] = plan(nodes, [svc()]);
    expect(p?.pool).toEqual(["a", "b"]);
    expect(p?.placements.reduce((n, pl) => n + pl.replicas, 0)).toBe(1);
  });
});

describe("planClusterPlacement: volume services (single-node + sticky)", () => {
  it("puts ALL replicas of a volume service on ONE node", () => {
    const nodes = [cnode("a"), cnode("b")];
    const [p] = plan(nodes, [svc({ hasVolumes: true, replicas: 3 })]);
    expect(p?.placements).toHaveLength(1);
    expect(p?.placements[0]?.replicas).toBe(3);
  });

  it("first deploy (stickyNodeId null) picks the node with the best headroom that fits all replicas", () => {
    const nodes = [cnode("a", { steadyCpu: 1024, steadyMemory: 1024 }), cnode("b")];
    const [p] = plan(nodes, [svc({ hasVolumes: true, replicas: 4 })]);
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 4 }]);
  });

  it("keeps a deployed volume service on its sticky node even when another node has more headroom", () => {
    const nodes = [cnode("a", { steadyCpu: 1024, steadyMemory: 1024 }), cnode("b")];
    const [p] = plan(nodes, [svc({ hasVolumes: true, stickyNodeId: "a", replicas: 2 })]);
    expect(p?.placements).toEqual([{ nodeId: "a", replicas: 2 }]);
  });

  it("throws a plain CliError (NOT CapacityPlacementError) when the sticky node no longer fits", () => {
    const nodes = [cnode("a", { allocatableCpu: 512, allocatableMemory: 512 }), cnode("b")];
    const attempt = () =>
      plan(nodes, [svc({ hasVolumes: true, stickyNodeId: "a", cpu: 512, memory: 512, replicas: 2 })]);
    expect(attempt).toThrow(CliError);
    expect(attempt).toThrow(/persistent volumes on node "a"/);
    expect(attempt).toThrow(/no longer has capacity/);
    try {
      attempt();
      expect.unreachable();
    } catch (e) {
      expect(e).not.toBeInstanceOf(CapacityPlacementError);
      expect((e as CliError).hint).toMatch(/can't move nodes without stranding its data/);
    }
  });

  it("places fresh on the best single node when the sticky node is gone (destroyed)", () => {
    const nodes = [cnode("a", { steadyCpu: 512, steadyMemory: 512 }), cnode("b")];
    const [p] = plan(nodes, [svc({ hasVolumes: true, stickyNodeId: "gone", replicas: 2 })]);
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 2 }]);
  });

  it("throws CapacityPlacementError when no node fits a first-deploy volume service", () => {
    const nodes = [cnode("a", { allocatableCpu: 512, allocatableMemory: 512 })];
    expect(() => plan(nodes, [svc({ hasVolumes: true, cpu: 512, memory: 512, replicas: 2 })])).toThrow(
      CapacityPlacementError,
    );
  });

  it("commits the volume service's demand so a later service sees it", () => {
    const nodes = [
      cnode("a", { allocatableCpu: 1024, allocatableMemory: 1024 }),
      cnode("b", { allocatableCpu: 1024, allocatableMemory: 1024 }),
    ];
    const db = svc({ name: "db", hasVolumes: true, stickyNodeId: "a", cpu: 512, memory: 512, isWeb: false });
    const next = svc({ name: "next", cpu: 512, memory: 512, isWeb: false });
    const plans = plan(nodes, [db, next]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 1 }]);
    expect(plans[1]?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });

  it("ignores stickyNodeId for a volume-less service", () => {
    const nodes = [cnode("a", { steadyCpu: 1024, steadyMemory: 1024 }), cnode("b")];
    const [p] = plan(nodes, [svc({ hasVolumes: false, stickyNodeId: "a" })]);
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });
});

describe("planClusterPlacement: bin-packing", () => {
  it("is deterministic — the same input twice yields the same plan", () => {
    const make = () => [
      cnode("a", { steadyCpu: 512, steadyMemory: 256 }),
      cnode("b"),
      cnode("c", { steadyCpu: 128, steadyMemory: 640 }),
    ];
    const services = () => [svc({ replicas: 5 })];
    expect(plan(make(), services())).toEqual(plan(make(), services()));
  });

  it("breaks exact ties by ascending nodeId", () => {
    const [p] = plan([cnode("b"), cnode("a")], [svc()]);
    expect(p?.placements).toEqual([{ nodeId: "a", replicas: 1 }]);
  });

  it("prefers the node with the most headroom, alternating as headroom equalizes", () => {
    const nodes = [cnode("a", { steadyCpu: 1024, steadyMemory: 1024 }), cnode("b")];
    const [p] = plan(nodes, [svc({ cpu: 512, memory: 512, replicas: 3 })]);
    // b (empty) takes 2 to reach a's load; the equal-headroom tie goes to a by id.
    expect(p?.placements).toEqual([
      { nodeId: "a", replicas: 1 },
      { nodeId: "b", replicas: 2 },
    ]);
  });

  it("skips a node that fits steady demand but not the rollout surge", () => {
    // One replica = 400 steady; two on one node = 800 steady + 400 surge = 1200 > 1024.
    const nodes = [cnode("a", { allocatableCpu: 1024 }), cnode("b", { allocatableCpu: 1024 })];
    const [p] = plan(nodes, [svc({ cpu: 400, memory: 100, replicas: 2 })]);
    expect(p?.placements).toEqual([
      { nodeId: "a", replicas: 1 },
      { nodeId: "b", replicas: 1 },
    ]);
  });

  it("accounts for another project's committed surge when gating", () => {
    // steady 600 + existing surge 300 leaves 1124 of 2048… placing one 512 replica
    // needs 600+512+max(300,512)=1624 ≤ 2048 (ok on a), but a second replica needs
    // 600+1024+512=2136 > 2048 → it must go to b.
    const nodes = [
      cnode("a", { steadyCpu: 600, maxSurgeCpu: 300 }),
      cnode("b", { steadyCpu: 900 }),
    ];
    const [p] = plan(nodes, [svc({ cpu: 512, memory: 64, replicas: 2 })]);
    expect(p?.placements).toEqual([
      { nodeId: "a", replicas: 1 },
      { nodeId: "b", replicas: 1 },
    ]);
  });

  it("lets a later service see an earlier service's consumption", () => {
    const nodes = [
      cnode("a", { allocatableCpu: 1024, allocatableMemory: 1024 }),
      cnode("b", { allocatableCpu: 1024, allocatableMemory: 1024 }),
    ];
    const big = svc({ name: "big", cpu: 512, memory: 512, isWeb: false });
    const next = svc({ name: "next", cpu: 512, memory: 512, isWeb: false });
    const plans = plan(nodes, [big, next]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 1 }]);
    expect(plans[1]?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });

  it("deprioritizes a node pre-seeded with committed demand", () => {
    const nodes = [cnode("a", { steadyCpu: 768, steadyMemory: 768 }), cnode("b")];
    const [p] = plan(nodes, [svc()]);
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });

  it("fails with a per-node breakdown when nothing fits", () => {
    const nodes = [
      cnode("a", { allocatableCpu: 512, steadyCpu: 256 }),
      cnode("b", { allocatableCpu: 512, steadyCpu: 128 }),
    ];
    try {
      plan(nodes, [svc({ cpu: 256, memory: 64, replicas: 2 })]);
      expect.unreachable();
    } catch (e) {
      const err = e as CliError;
      expect(err).toBeInstanceOf(CapacityPlacementError);
      expect(err.message).toMatch(/service "web" does not fit: replica \d of 2/);
      expect(err.message).toMatch(/a {2}free 0\.25 vCPU/);
      expect(err.message).toMatch(/b {2}free/);
      expect(err.message).toMatch(/needs 0\.25 vCPU · 64 MB/);
      expect(err.hint).toMatch(/free capacity on a node/);
    }
  });
});
