import {
  nodeRegistryKey,
  statusKey,
  type NodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCandidateNodes } from "./candidate-nodes";

const s3State = vi.hoisted(() => ({
  getJson: vi.fn(),
  listNodeIds: vi.fn(),
}));

vi.mock("../aws/s3-state", () => s3State);

const NOW = Date.parse("2026-06-20T00:00:00.000Z");

function node(
  nodeId: string,
  over: Partial<NodeRegistryEntry> = {},
): NodeRegistryEntry {
  return {
    nodeId,
    clusterId: "default",
    instanceId: "i-123",
    instanceType: "t3.small",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    role: "app",
    privateIp: "10.0.0.5",
    totalCpu: 2048,
    totalMemory: 2048,
    reservedCpu: 256,
    reservedMemory: 512,
    publicIp: null,
    eipAllocationId: null,
    securityGroupId: "sg-1",
    iamInstanceProfile: "profile",
    provisioning: "ec2",
    advertiseIp: null,
    iamUserName: null,
    agentId: `agent-${nodeId}`,
    agentVersion: "0.1.0",
    agentType: "rust",
    createdAt: "2026-06-20T00:00:00.000Z",
    createdBy: "tester",
    state: "ready",
    ...over,
  };
}

function external(nodeId: string): NodeRegistryEntry {
  return node(nodeId, {
    instanceId: null,
    instanceType: "external",
    privateIp: null,
    availabilityZone: null,
    securityGroupId: null,
    iamInstanceProfile: null,
    provisioning: "external",
    advertiseIp: "203.0.113.10",
    iamUserName: `launch-pad-node-default-${nodeId}`,
  });
}

function status(nodeId: string, lastSeen: string): unknown {
  return {
    nodeId,
    agentId: `agent-${nodeId}`,
    lastSeen,
    agentVersion: "0.1.0",
    services: [],
    caddy: { managed: false, lastReloadAt: null, error: null },
  };
}

describe("buildCandidateNodes", () => {
  beforeEach(() => {
    s3State.getJson.mockReset();
    s3State.listNodeIds.mockReset();
  });

  it("keeps stale external nodes out of the schedulable placement pool", async () => {
    const entries = new Map<string, NodeRegistryEntry>([
      ["ec2-1", node("ec2-1")],
      ["fresh-byos", external("fresh-byos")],
      ["stale-byos", external("stale-byos")],
      ["missing-status-byos", external("missing-status-byos")],
      ["terminating-byos", { ...external("terminating-byos"), state: "terminating" }],
      ["edge-1", node("edge-1", { role: "edge" })],
    ]);
    s3State.listNodeIds.mockResolvedValue([...entries.keys()]);
    s3State.getJson.mockImplementation(async (_s3, _bucket, key: string) => {
      for (const [id, entry] of entries) {
        if (key === nodeRegistryKey("default", id)) return { raw: entry, etag: "etag" };
      }
      if (key === statusKey("default", "fresh-byos")) {
        return { raw: status("fresh-byos", "2026-06-19T23:59:45.000Z"), etag: "etag" };
      }
      if (key === statusKey("default", "stale-byos")) {
        return { raw: status("stale-byos", "2026-06-19T23:58:00.000Z"), etag: "etag" };
      }
      return null;
    });

    const result = await buildCandidateNodes(
      { s3: {}, bucket: "bucket", clusterId: "default" } as never,
      "my-app",
      { needsCapacitySnapshot: false, nowMs: NOW },
    );

    expect([...result.nodes.keys()]).toEqual([
      "ec2-1",
      "fresh-byos",
      "stale-byos",
      "missing-status-byos",
      "terminating-byos",
      "edge-1",
    ]);
    expect(result.clusterAppNodeIds).toEqual(["ec2-1", "fresh-byos"]);
    expect(result.candidateNodes.map((n) => n.nodeId)).toEqual(["ec2-1", "fresh-byos"]);
  });
});
