import type { NodeRegistryEntry, NodeRole, NodeState } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { buildProvisionPlan, type NodeDemand, planEdgeAction } from "./provision-plan";

function demand(over: Partial<NodeDemand> & { nodeId: string }): NodeDemand {
  return {
    cpu: 0,
    memory: 0,
    ...over,
  };
}

function fakeEntry(nodeId: string, state: NodeState, role: NodeRole = "app"): NodeRegistryEntry {
  return {
    nodeId,
    clusterId: "default",
    instanceId: "i-123",
    instanceType: "t3.small",
    region: "us-east-1",
    availabilityZone: null,
    role,
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
    agentType: "ts",
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: "tester",
    state,
  };
}

const EDGE = "edge-1";

describe("planEdgeAction", () => {
  it("classifies an existing running edge node as ready", async () => {
    const entry = fakeEntry(EDGE, "ready", "edge");
    const action = await planEdgeAction({ edgeNodeId: EDGE, load: async () => entry, allowCreate: true });
    expect(action).toEqual({ kind: "ready", nodeId: EDGE, entry });
  });

  it("classifies a paused edge node as resume", async () => {
    const entry = fakeEntry(EDGE, "stopped", "edge");
    const action = await planEdgeAction({ edgeNodeId: EDGE, load: async () => entry, allowCreate: true });
    expect(action).toEqual({ kind: "resume", nodeId: EDGE, entry });
  });

  it("classifies a legacy both-role node as ready when it fronts ingress", async () => {
    const entry = fakeEntry(EDGE, "ready", "both");
    const action = await planEdgeAction({ edgeNodeId: EDGE, load: async () => entry, allowCreate: true });
    expect(action).toEqual({ kind: "ready", nodeId: EDGE, entry });
  });

  it("throws when the named edge node exists with a non-edge role", async () => {
    const entry = fakeEntry(EDGE, "ready", "app");
    await expect(
      planEdgeAction({ edgeNodeId: EDGE, load: async () => entry, allowCreate: true }),
    ).rejects.toThrow(/is the cluster's edge but has role "app"/);
  });

  it("throws for a missing edge node when allowCreate is false", async () => {
    await expect(
      planEdgeAction({ edgeNodeId: EDGE, load: async () => null, allowCreate: false }),
    ).rejects.toThrow(/edge node "edge-1" does not exist/);
  });

  it("creates a missing edge node with role edge on the default edge instance type", async () => {
    const action = await planEdgeAction({ edgeNodeId: EDGE, load: async () => null, allowCreate: true });
    expect(action).toMatchObject({
      kind: "create",
      nodeId: EDGE,
      role: "edge",
      instanceType: "t3.micro",
    });
  });
});

describe("buildProvisionPlan", () => {
  const ready = (id: string) => fakeEntry(id, "ready");

  it("classifies existing running nodes as ready", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "a" })],
      edgeNodeId: EDGE,
      load: async (id) => ready(id),
      allowCreate: true,
    });
    expect(plan).toEqual([{ kind: "ready", nodeId: "a", entry: ready("a") }]);
  });

  it("classifies a paused node as resume", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "a" })],
      edgeNodeId: EDGE,
      load: async (id) => fakeEntry(id, "stopped"),
      allowCreate: true,
    });
    expect(plan[0]?.kind).toBe("resume");
  });

  it("auto-sizes a missing node into an app-role create fronted by the cluster edge", async () => {
    const plan = await buildProvisionPlan({
      demands: [demand({ nodeId: "web", cpu: 1024, memory: 2048 })],
      edgeNodeId: EDGE,
      load: async () => null,
      allowCreate: true,
    });
    expect(plan[0]).toMatchObject({
      kind: "create",
      nodeId: "web",
      role: "app",
      edgeNodeId: EDGE,
      instanceType: "t3.medium", // 2048 MB demand needs totalMem ≥ 2560 → the 4 GB tier
    });
  });

  it("sizes a created node for the rollout surge, not just steady state", async () => {
    // 1024 MB steady fits t3.small (allocatable 1536)…
    const steadyOnly = await buildProvisionPlan({
      demands: [demand({ nodeId: "n", cpu: 512, memory: 1024 })],
      edgeNodeId: EDGE,
      load: async () => null,
      allowCreate: true,
    });
    expect(steadyOnly[0]).toMatchObject({ instanceType: "t3.small" });

    // …but +1024 MB surge → 2048 peak needs the 4 GB tier.
    const withSurge = await buildProvisionPlan({
      demands: [demand({ nodeId: "n", cpu: 512, memory: 1024, surgeMemory: 1024 })],
      edgeNodeId: EDGE,
      load: async () => null,
      allowCreate: true,
    });
    expect(withSurge[0]).toMatchObject({ instanceType: "t3.medium" });
  });

  it("throws for a missing node when allowCreate is false (strict mode)", async () => {
    await expect(
      buildProvisionPlan({
        demands: [demand({ nodeId: "ghost" })],
        edgeNodeId: EDGE,
        load: async () => null,
        allowCreate: false,
      }),
    ).rejects.toThrow(/node "ghost" does not exist/);
  });

  it("throws when no instance type can fit the demand", async () => {
    await expect(
      buildProvisionPlan({
        demands: [demand({ nodeId: "huge", cpu: 999_999, memory: 0 })],
        edgeNodeId: EDGE,
        load: async () => null,
        allowCreate: true,
      }),
    ).rejects.toThrow(/no instance type fits/);
  });
});
