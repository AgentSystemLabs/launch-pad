import { describe, expect, it } from "vitest";
import type { NodeRole, ServiceDecl } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import {
  bootstrapCandidateNode,
  type CandidateNode,
  CapacityPlacementError,
  type ClusterServiceInput,
  distributeReplicas,
  nextAppNodeId,
  planClusterPlacement,
  planClusterPlacementAutoAdd,
  planPlacement,
  templateCandidateNode,
} from "./placement";

function decl(over: Partial<ServiceDecl>): ServiceDecl {
  return {
    name: "web",
    dockerfile: "./Dockerfile",
    context: ".",
    replicas: 1,
    cpu: 256,
    memory: 256,
    env: {},
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    ...over,
  } as ServiceDecl;
}

describe("planPlacement", () => {
  it("places all replicas on a single node", () => {
    expect(planPlacement(decl({ node: "a", replicas: 2 }))).toEqual([{ nodeId: "a", replicas: 2 }]);
  });

  it("round-robins evenly across nodes", () => {
    expect(planPlacement(decl({ nodes: ["a", "b"], replicas: 4 }))).toEqual([
      { nodeId: "a", replicas: 2 },
      { nodeId: "b", replicas: 2 },
    ]);
  });

  it("gives the remainder to the earlier nodes", () => {
    expect(planPlacement(decl({ nodes: ["a", "b"], replicas: 3 }))).toEqual([
      { nodeId: "a", replicas: 2 },
      { nodeId: "b", replicas: 1 },
    ]);
  });

  it("drops nodes that receive zero replicas", () => {
    expect(planPlacement(decl({ nodes: ["a", "b", "c"], replicas: 1 }))).toEqual([
      { nodeId: "a", replicas: 1 },
    ]);
  });
});

describe("distributeReplicas (cluster auto-placement)", () => {
  it("spreads replicas round-robin across resolved cluster nodes", () => {
    expect(distributeReplicas(["dev-app", "staging-app"], 3)).toEqual([
      { nodeId: "dev-app", replicas: 2 },
      { nodeId: "staging-app", replicas: 1 },
    ]);
  });

  it("returns nothing when the cluster has no app nodes", () => {
    expect(distributeReplicas([], 4)).toEqual([]);
  });
});

/** A candidate with 2 vCPU / 2048 MB allocatable and nothing running, unless overridden. */
function cnode(nodeId: string, role: NodeRole = "app", over: Partial<CandidateNode> = {}): CandidateNode {
  return {
    nodeId,
    role,
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
    explicitEdge: null,
    schedule: "even",
    topology: "auto",
    ...over,
  };
}

function plan(
  nodes: CandidateNode[],
  services: ClusterServiceInput[],
  clusterDefaultEdge: string | null = null,
) {
  return planClusterPlacement({ clusterId: "lower", clusterDefaultEdge, nodes, services });
}

describe("bootstrapCandidateNode (empty-cluster bootstrap)", () => {
  it("is a both-role node so it's eligible for every topology's pool", () => {
    const n = bootstrapCandidateNode("app-1");
    expect(n.nodeId).toBe("app-1");
    expect(n.role).toBe("both");
    expect(n.steadyCpu).toBe(0);
    expect(n.steadyMemory).toBe(0);
  });

  it("has enough capacity that the planner places a large demand onto it", () => {
    const n = bootstrapCandidateNode("app-1");
    // A worker the largest real instance couldn't hold still fits the synthetic node —
    // the real instance is auto-sized to the demand at provision time, not here.
    const [p] = plan([n], [svc({ isWeb: false, schedule: "capacity", cpu: 8192, memory: 65536, replicas: 4 })], null);
    expect(p?.placements).toEqual([{ nodeId: "app-1", replicas: 4 }]);
  });

  it("places a co-located web service onto the single bootstrap node (no edge)", () => {
    const [p] = plan([bootstrapCandidateNode("app-1")], [svc({ topology: "co-located", replicas: 2 })], null);
    expect(p?.placements).toEqual([{ nodeId: "app-1", replicas: 2 }]);
    expect(p?.edge).toBeNull();
  });

  it("routes a split web service through the cluster default edge onto the bootstrap node", () => {
    const [p] = plan([bootstrapCandidateNode("app-1")], [svc({ topology: "split" })], "edge-1");
    expect(p?.placements).toEqual([{ nodeId: "app-1", replicas: 1 }]);
    expect(p?.edge).toBe("edge-1");
  });

  it("still rejects a split service with no edge (planner owns the topology rules)", () => {
    expect(() => plan([bootstrapCandidateNode("app-1")], [svc({ topology: "split" })], null)).toThrow(
      /topology = "split" but no edge fronts it/,
    );
  });
});

describe("nextAppNodeId", () => {
  it("returns app-1 for an empty cluster", () => {
    expect(nextAppNodeId([])).toBe("app-1");
  });
  it("returns the lowest unused app-<n>", () => {
    expect(nextAppNodeId(["app-1", "node-x"])).toBe("app-2");
    expect(nextAppNodeId(["app-1", "app-2"])).toBe("app-3");
    // Reuses a freed lower index.
    expect(nextAppNodeId(["app-2", "app-3"])).toBe("app-1");
  });
});

describe("templateCandidateNode", () => {
  it("sizes a new node like the cluster's largest existing node (role both, zero demand)", () => {
    const existing = [cnode("a", "app", { allocatableCpu: 1024, allocatableMemory: 2048 }), cnode("b")];
    const t = templateCandidateNode("app-2", existing);
    expect(t.role).toBe("both");
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
  const input = (nodes: CandidateNode[], services: ClusterServiceInput[], edge: string | null = null) => ({
    clusterId: "lower",
    clusterDefaultEdge: edge,
    nodes,
    services,
  });

  it("adds no node when the existing pool already fits (capacity schedule)", () => {
    const nodes = [cnode("a", "app", { allocatableCpu: 4096, allocatableMemory: 4096 })];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ schedule: "capacity", isWeb: false, replicas: 2 })]),
      { maxAdd: 8, existingNodeIds: ["a"] },
    );
    expect(added).toEqual([]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 2 }]);
  });

  it("auto-adds capacity-schedule nodes until every replica fits", () => {
    // One small node (fits ~1 replica incl. surge); 3 replicas need more nodes.
    const nodes = [cnode("a", "app", { allocatableCpu: 512, allocatableMemory: 512 })];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ schedule: "capacity", isWeb: false, cpu: 256, memory: 256, replicas: 3 })]),
      { maxAdd: 8, existingNodeIds: ["a"] },
    );
    const total = plans[0]!.placements.reduce((n, p) => n + p.replicas, 0);
    expect(total).toBe(3);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((n) => n.role === "both")).toBe(true);
    // Names are app-<n>, not colliding with the existing "a".
    expect(added.map((n) => n.nodeId)).toEqual(added.map((n) => n.nodeId).filter((id) => /^app-\d+$/.test(id)));
  });

  it("auto-adds for an EVEN schedule when the round-robin spread overflows the pool", () => {
    // 2 nodes, each fits 1 replica (256 + 256 surge = 512); 4 replicas even = 2/node → overflow.
    const nodes = [
      cnode("a", "app", { allocatableCpu: 512, allocatableMemory: 512 }),
      cnode("b", "app", { allocatableCpu: 512, allocatableMemory: 512 }),
    ];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ schedule: "even", isWeb: false, cpu: 256, memory: 256, replicas: 4 })], "e"),
      { maxAdd: 8, existingNodeIds: ["a", "b"] },
    );
    expect(added.length).toBeGreaterThan(0);
    // After adding, no node holds more than it can fit (256 steady + 256 surge ≤ 512).
    for (const p of plans[0]!.placements) {
      expect(p.replicas).toBeLessThanOrEqual(1);
    }
  });

  it("does not add for an even overflow when maxAdd is 0 (returns the plan; deploy errors later)", () => {
    const nodes = [cnode("a", "app", { allocatableCpu: 512, allocatableMemory: 512 })];
    const { plans, added } = planClusterPlacementAutoAdd(
      input(nodes, [svc({ schedule: "even", isWeb: false, cpu: 256, memory: 256, replicas: 4 })], "e"),
      { maxAdd: 0, existingNodeIds: ["a"] },
    );
    expect(added).toEqual([]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 4 }]);
  });

  it("rethrows a capacity error when maxAdd is 0 (capacity schedule)", () => {
    const nodes = [cnode("a", "app", { allocatableCpu: 256, allocatableMemory: 256 })];
    expect(() =>
      planClusterPlacementAutoAdd(
        input(nodes, [svc({ schedule: "capacity", isWeb: false, cpu: 256, memory: 256, replicas: 3 })]),
        { maxAdd: 0, existingNodeIds: ["a"] },
      ),
    ).toThrow(CapacityPlacementError);
  });

  it("rethrows a NON-capacity planner error immediately (adding nodes won't fix it)", () => {
    const nodes = [cnode("a", "app", { allocatableCpu: 4096, allocatableMemory: 4096 })];
    expect(() =>
      planClusterPlacementAutoAdd(input(nodes, [svc({ topology: "split" })]), {
        maxAdd: 8,
        existingNodeIds: ["a"],
      }),
    ).toThrow(/topology = "split" but no edge fronts it/);
  });
});

describe("planClusterPlacement: even + auto (legacy byte-compat)", () => {
  it("matches distributeReplicas over the app+both pool for every pool/replica combo", () => {
    for (const poolIds of [["a"], ["a", "b"], ["a", "b", "c"]]) {
      for (const replicas of [1, 3, 4]) {
        const nodes = poolIds.map((id) => cnode(id));
        const [p] = plan(nodes, [svc({ replicas })], "edge-1");
        expect(p?.placements).toEqual(distributeReplicas(poolIds, replicas));
        expect(p?.pool).toEqual(poolIds);
      }
    }
  });

  it("excludes edge-role nodes from the pool but keeps both-role nodes", () => {
    const nodes = [cnode("a"), cnode("b", "both"), cnode("e", "edge")];
    const [p] = plan(nodes, [svc({ replicas: 3 })], "e");
    expect(p?.placements).toEqual(distributeReplicas(["a", "b"], 3));
  });

  it("resolves edge as explicitEdge ?? clusterDefaultEdge, even for a single-node pool", () => {
    expect(plan([cnode("a")], [svc()], "edge-1")[0]?.edge).toBe("edge-1");
    expect(plan([cnode("a")], [svc({ explicitEdge: "edge-2" })], "edge-1")[0]?.edge).toBe("edge-2");
    expect(plan([cnode("a")], [svc()])[0]?.edge).toBeNull();
  });

  it("errors with the legacy message when a multi-node-pool web service has no edge", () => {
    expect(() => plan([cnode("a"), cnode("b")], [svc({ replicas: 1 })])).toThrow(
      /service "web" spans 2 nodes but has no edge to load-balance them/,
    );
    try {
      plan([cnode("a"), cnode("b")], [svc()]);
      expect.unreachable();
    } catch (e) {
      expect((e as CliError).hint).toMatch(/cluster set-edge lower/);
    }
  });

  it("gives a worker a null edge even when the cluster has a default edge", () => {
    const [p] = plan([cnode("a"), cnode("b")], [svc({ isWeb: false, replicas: 2 })], "edge-1");
    expect(p?.edge).toBeNull();
    expect(p?.placements).toEqual(distributeReplicas(["a", "b"], 2));
  });
});

describe("planClusterPlacement: split", () => {
  it("requires an edge even with a single-node pool", () => {
    expect(() => plan([cnode("a")], [svc({ topology: "split" })])).toThrow(
      /topology = "split" but no edge fronts it/,
    );
  });

  it("uses the explicit edge over the cluster default", () => {
    const [p] = plan([cnode("a")], [svc({ topology: "split", explicitEdge: "edge-2" })], "edge-1");
    expect(p?.edge).toBe("edge-2");
  });

  it("distributes evenly over the app+both pool", () => {
    const nodes = [cnode("a"), cnode("b", "both")];
    const [p] = plan(nodes, [svc({ topology: "split", replicas: 3 })], "edge-1");
    expect(p?.placements).toEqual(distributeReplicas(["a", "b"], 3));
    expect(p?.edge).toBe("edge-1");
  });
});

describe("planClusterPlacement: co-located", () => {
  it("puts all replicas on the first both-role node under even", () => {
    const nodes = [cnode("a"), cnode("b", "both"), cnode("c", "both")];
    const [p] = plan(nodes, [svc({ topology: "co-located", replicas: 3 })], "edge-1");
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 3 }]);
    expect(p?.pool).toEqual(["b", "c"]);
  });

  it("keeps edge null even when the cluster has a default edge", () => {
    const [p] = plan([cnode("b", "both")], [svc({ topology: "co-located" })], "edge-1");
    expect(p?.edge).toBeNull();
  });

  it("errors when the cluster has no both-role node", () => {
    expect(() => plan([cnode("a"), cnode("e", "edge")], [svc({ topology: "co-located" })])).toThrow(
      /no both-role node to host it/,
    );
  });

  it("under capacity, picks the both node with room for ALL replicas", () => {
    const nodes = [
      cnode("b1", "both", { steadyCpu: 1024, steadyMemory: 1024 }),
      cnode("b2", "both"),
    ];
    const [p] = plan(nodes, [svc({ topology: "co-located", schedule: "capacity", replicas: 4 })], null);
    expect(p?.placements).toEqual([{ nodeId: "b2", replicas: 4 }]);
  });
});

describe("planClusterPlacement: capacity", () => {
  it("is deterministic — the same input twice yields the same plan", () => {
    const make = () => [
      cnode("a", "app", { steadyCpu: 512, steadyMemory: 256 }),
      cnode("b"),
      cnode("c", "both", { steadyCpu: 128, steadyMemory: 640 }),
    ];
    const services = () => [svc({ schedule: "capacity", replicas: 5 })];
    expect(plan(make(), services(), "e")).toEqual(plan(make(), services(), "e"));
  });

  it("breaks exact ties by ascending nodeId", () => {
    const [p] = plan([cnode("b"), cnode("a")], [svc({ schedule: "capacity" })], "e");
    expect(p?.placements).toEqual([{ nodeId: "a", replicas: 1 }]);
  });

  it("prefers the node with the most headroom, alternating as headroom equalizes", () => {
    const nodes = [cnode("a", "app", { steadyCpu: 1024, steadyMemory: 1024 }), cnode("b")];
    const [p] = plan(nodes, [svc({ schedule: "capacity", cpu: 512, memory: 512, replicas: 3 })], "e");
    // b (empty) takes 2 to reach a's load; the equal-headroom tie goes to a by id.
    expect(p?.placements).toEqual([
      { nodeId: "a", replicas: 1 },
      { nodeId: "b", replicas: 2 },
    ]);
  });

  it("skips a node that fits steady demand but not the rollout surge", () => {
    // One replica = 400 steady; two on one node = 800 steady + 400 surge = 1200 > 1024.
    const nodes = [cnode("a", "app", { allocatableCpu: 1024 }), cnode("b", "app", { allocatableCpu: 1024 })];
    const [p] = plan(nodes, [svc({ schedule: "capacity", cpu: 400, memory: 100, replicas: 2 })], "e");
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
      cnode("a", "app", { steadyCpu: 600, maxSurgeCpu: 300 }),
      cnode("b", "app", { steadyCpu: 900 }),
    ];
    const [p] = plan(nodes, [svc({ schedule: "capacity", cpu: 512, memory: 64, replicas: 2 })], "e");
    expect(p?.placements).toEqual([
      { nodeId: "a", replicas: 1 },
      { nodeId: "b", replicas: 1 },
    ]);
  });

  it("lets a later service see an earlier service's consumption", () => {
    const nodes = [cnode("a", "app", { allocatableCpu: 1024, allocatableMemory: 1024 }), cnode("b", "app", { allocatableCpu: 1024, allocatableMemory: 1024 })];
    const big = svc({ name: "big", schedule: "capacity", cpu: 512, memory: 512, isWeb: false });
    const next = svc({ name: "next", schedule: "capacity", cpu: 512, memory: 512, isWeb: false });
    const plans = plan(nodes, [big, next]);
    expect(plans[0]?.placements).toEqual([{ nodeId: "a", replicas: 1 }]);
    expect(plans[1]?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });

  it("deprioritizes a node pre-seeded with pinned demand", () => {
    const nodes = [cnode("a", "app", { steadyCpu: 768, steadyMemory: 768 }), cnode("b")];
    const [p] = plan(nodes, [svc({ schedule: "capacity" })], "e");
    expect(p?.placements).toEqual([{ nodeId: "b", replicas: 1 }]);
  });

  it("fails with a per-node breakdown when nothing fits", () => {
    const nodes = [
      cnode("a", "app", { allocatableCpu: 512, steadyCpu: 256 }),
      cnode("b", "app", { allocatableCpu: 512, steadyCpu: 128 }),
    ];
    try {
      plan(nodes, [svc({ schedule: "capacity", cpu: 256, memory: 64, replicas: 2 })], "e");
      expect.unreachable();
    } catch (e) {
      const err = e as CliError;
      expect(err.message).toMatch(/service "web" does not fit: replica \d of 2/);
      expect(err.message).toMatch(/a {2}free 0\.25 vCPU/);
      expect(err.message).toMatch(/b {2}free/);
      expect(err.message).toMatch(/needs 0\.25 vCPU · 64 MB/);
      expect(err.hint).toMatch(/free capacity on a node/);
    }
  });
});
