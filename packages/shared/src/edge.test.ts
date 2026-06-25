import { describe, expect, it } from "vitest";
import type { DesiredState } from "./desired";
import {
  buildEdgeBackendsByCrossRead,
  buildEdgeBackendsFromShards,
  type ClusterNode,
  edgeHealthPathForDomain,
  type UpstreamShard,
} from "./edge";
import type { NodeRegistryEntry } from "./registry";
import type { NodeStatus, ReplicaStatus } from "./status";

function entry(nodeId: string, privateIp: string | null): NodeRegistryEntry {
  return {
    nodeId,
    clusterId: "default",
    instanceId: "i-1",
    instanceType: "t3.small",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    role: "app",
    privateIp,
    totalCpu: 2048,
    totalMemory: 2048,
    reservedCpu: 256,
    reservedMemory: 512,
    publicIp: null,
    eipAllocationId: null,
    securityGroupId: "sg-1",
    iamInstanceProfile: "p",
    provisioning: "ec2",
    advertiseIp: null,
    iamUserName: null,
    agentId: `agent-${nodeId}`,
    agentVersion: "0.0.0",
    agentType: "ts",
    createdAt: "t",
    createdBy: "x",
    state: "ready",
  };
}

function replica(index: number, hostPort: number, state: string, healthy: boolean): ReplicaStatus {
  return { index, containerId: `c${index}`, hostPort, state: state as ReplicaStatus["state"], image: "img", healthy };
}

function desired(nodeId: string, edge: string): DesiredState {
  return {
    version: 2,
    nodeId,
    updatedAt: "t",
    services: [
      {
        project: "p",
        service: "web",
        image: "img",
        cpu: 256,
        memory: 256,
        replicas: 2,
        env: {},
        secretRefs: [],
        ingress: { domain: "app.example.com", port: 3000, edge },
        healthCheck: null,
        rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
        volumes: [],
      },
    ],
  };
}

function status(nodeId: string, replicas: ReplicaStatus[]): NodeStatus {
  return {
    nodeId,
    agentId: `agent-${nodeId}`,
    lastSeen: "t",
    agentVersion: "0.0.0",
    services: [
      {
        project: "p",
        service: "web",
        image: "img",
        state: "running",
        message: "",
        containerId: "c0",
        replicas,
        desiredReplicas: 2,
        runningReplicas: replicas.filter((r) => r.state === "running").length,
        updatedAt: "t",
      },
    ],
    caddy: { managed: false, lastReloadAt: null, error: null },
    edgeRoutes: [],
  };
}

describe("buildEdgeBackendsByCrossRead", () => {
  it("collects running + healthy replicas across app nodes for owned domains", () => {
    const nodes: ClusterNode[] = [
      { entry: entry("edge-1", "10.0.0.1"), status: null, desired: null },
      {
        entry: entry("app-1", "10.0.1.5"),
        desired: desired("app-1", "edge-1"),
        status: status("app-1", [replica(0, 20001, "running", true), replica(1, 20002, "running", true)]),
      },
      {
        entry: entry("app-2", "10.0.1.6"),
        desired: desired("app-2", "edge-1"),
        status: status("app-2", [
          replica(0, 20001, "running", true),
          replica(1, 20002, "starting", false), // excluded: not running+healthy
        ]),
      },
    ];
    const backends = buildEdgeBackendsByCrossRead("edge-1", nodes);
    const app = backends.get("app.example.com") ?? [];
    expect(app).toHaveLength(3); // app-1×2 + app-2×1
    expect(app).toContainEqual({ domain: "app.example.com", privateIp: "10.0.1.5", hostPort: 20001 });
    expect(app).toContainEqual({ domain: "app.example.com", privateIp: "10.0.1.6", hostPort: 20001 });
  });

  it("ignores nodes owned by a different edge and nodes without a private ip", () => {
    const nodes: ClusterNode[] = [
      {
        entry: entry("app-1", null), // no privateIp → skipped
        desired: desired("app-1", "edge-1"),
        status: status("app-1", [replica(0, 20001, "running", true)]),
      },
      {
        entry: entry("app-2", "10.0.1.6"),
        desired: desired("app-2", "edge-2"), // different edge → skipped
        status: status("app-2", [replica(0, 20001, "running", true)]),
      },
    ];
    expect(buildEdgeBackendsByCrossRead("edge-1", nodes).size).toBe(0);
  });
});

describe("buildEdgeBackendsFromShards", () => {
  it("collects backends from upstream shards", () => {
    const shards: UpstreamShard[] = [
      {
        nodeId: "app-1",
        privateIp: "10.0.1.5",
        updatedAt: "t",
        backends: [
          { domain: "app.example.com", hostPort: 20001, healthPath: "/health" },
          { domain: "app.example.com", hostPort: 20002 },
        ],
      },
      {
        nodeId: "app-2",
        privateIp: "10.0.1.6",
        updatedAt: "t",
        backends: [{ domain: "app.example.com", hostPort: 20001 }],
      },
    ];
    const backends = buildEdgeBackendsFromShards(shards);
    expect(backends.get("app.example.com")).toHaveLength(3);
    expect(edgeHealthPathForDomain(shards, "app.example.com")).toBe("/health");
  });
});
