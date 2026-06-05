import type { NodeRegistryEntry, NodeState } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { buildProvisionPlan, inferNodeRole, type NodeDemand } from "./provision-plan";

function demand(over: Partial<NodeDemand> & { nodeId: string }): NodeDemand {
  return {
    isEdgeRef: false,
    isAppTarget: true,
    coLocatedWeb: false,
    frontingEdges: [],
    cpu: 0,
    memory: 0,
    ...over,
  };
}

function fakeEntry(nodeId: string, state: NodeState): NodeRegistryEntry {
  return {
    nodeId,
    clusterId: "default",
    instanceId: "i-123",
    instanceType: "t3.small",
    region: "us-east-1",
    availabilityZone: null,
    role: "both",
    privateIp: null,
    totalCpu: 2048,
    totalMemory: 2048,
    reservedCpu: 256,
    reservedMemory: 512,
    publicIp: null,
    eipAllocationId: null,
    securityGroupId: null,
    iamInstanceProfile: null,
    agentId: `agent-${nodeId}`,
    agentVersion: null,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "tester",
    state,
  };
}

describe("inferNodeRole", () => {
  it("a node referenced only as an edge → edge", () => {
    expect(inferNodeRole(demand({ nodeId: "e", isEdgeRef: true, isAppTarget: false }))).toEqual({
      role: "edge",
    });
  });

  it("a node that is both an edge and an app target → both", () => {
    expect(inferNodeRole(demand({ nodeId: "x", isEdgeRef: true, isAppTarget: true }))).toEqual({
      role: "both",
    });
  });

  it("an app target serving a co-located web service → both (needs Caddy)", () => {
    expect(inferNodeRole(demand({ nodeId: "n", coLocatedWeb: true }))).toEqual({ role: "both" });
  });

  it("an app target fronted by exactly one edge → app + that edge", () => {
    expect(inferNodeRole(demand({ nodeId: "n", frontingEdges: ["edge-1"] }))).toEqual({
      role: "app",
      edgeNodeId: "edge-1",
    });
  });

  it("an app target fronted by multiple edges → both (can't pin one edge SG)", () => {
    expect(inferNodeRole(demand({ nodeId: "n", frontingEdges: ["e1", "e2"] }))).toEqual({
      role: "both",
    });
  });

  it("a worker-only node (no edge, no co-located web) → both", () => {
    expect(inferNodeRole(demand({ nodeId: "w" }))).toEqual({ role: "both" });
  });
});

describe("buildProvisionPlan", () => {
  const ready = (id: string) => fakeEntry(id, "ready");

  it("classifies existing running nodes as ready", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "a" })],
      load: async (id) => ready(id),
      allowCreate: true,
    });
    expect(plan).toEqual([{ kind: "ready", nodeId: "a", entry: ready("a") }]);
  });

  it("classifies a paused node as resume", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "a" })],
      load: async (id) => fakeEntry(id, "stopped"),
      allowCreate: true,
    });
    expect(plan[0]?.kind).toBe("resume");
  });

  it("auto-sizes + role-infers a missing node into a create action", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "web", cpu: 1024, memory: 2048, coLocatedWeb: true })],
      load: async () => null,
      allowCreate: true,
    });
    expect(plan[0]).toMatchObject({
      kind: "create",
      nodeId: "web",
      role: "both",
      instanceType: "t3.medium", // 2048 MB demand needs totalMem ≥ 2560 → the 4 GB tier
    });
  });

  it("sizes a created node for the rollout surge, not just steady state", async () => {
    // 1024 MB steady fits t3.small (allocatable 1536)…
    const steadyOnly = await buildProvisionPlan({
      demands: [demand({ nodeId: "n", cpu: 512, memory: 1024 })],
      load: async () => null,
      allowCreate: true,
    });
    expect(steadyOnly[0]).toMatchObject({ instanceType: "t3.small" });

    // …but +1024 MB surge → 2048 peak needs the 4 GB tier.
    const withSurge = await buildProvisionPlan({
      demands: [demand({ nodeId: "n", cpu: 512, memory: 1024, surgeMemory: 1024 })],
      load: async () => null,
      allowCreate: true,
    });
    expect(withSurge[0]).toMatchObject({ instanceType: "t3.medium" });
  });

  it("creates a missing app node fronted by an edge, with its edge attached", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "app-1", frontingEdges: ["edge-1"], cpu: 256, memory: 256 })],
      load: async () => null,
      allowCreate: true,
    });
    expect(plan[0]).toMatchObject({ kind: "create", role: "app", edgeNodeId: "edge-1" });
  });

  it("throws for a missing node when allowCreate is false (strict mode)", async () => {
    await expect(
      buildProvisionPlan({
        demands: [demand({ nodeId: "ghost" })],
        load: async () => null,
        allowCreate: false,
      }),
    ).rejects.toThrow(/node "ghost" does not exist/);
  });

  it("throws when no instance type can fit the demand", async () => {
    await expect(
      buildProvisionPlan({
        demands: [demand({ nodeId: "huge", cpu: 999_999, memory: 0 })],
        load: async () => null,
        allowCreate: true,
      }),
    ).rejects.toThrow(/no instance type fits/);
  });
});
