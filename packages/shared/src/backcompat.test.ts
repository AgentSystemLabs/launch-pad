import { describe, expect, it } from "vitest";
import { parseDesiredState } from "./desired";
import { parseNodeRegistryEntry } from "./registry";
import { parseNodeStatus } from "./status";

// Protocol v2: desired.json requires `version: 2` and a non-null `ingress.edge`
// node.json requires an explicit role ("app" | "edge" | legacy "both").
// Fields added AFTER v2 must still default so v2 documents keep parsing.

describe("compatibility with protocol-v2 S3 documents", () => {
  it("parses a minimal v2 desired.json (no replicas / healthCheck / rollout)", () => {
    const minimal = {
      version: 2,
      nodeId: "node-prod-1",
      updatedAt: "2026-06-04T00:00:00Z",
      services: [
        {
          project: "example-express",
          service: "web",
          image: "ecr/example-express/web:abc",
          cpu: 512,
          memory: 512,
          env: { NODE_ENV: "production" },
          ingress: { domain: "x.example.com", port: 3000, edge: "edge-1" },
        },
      ],
    };
    const d = parseDesiredState(minimal);
    expect(d.services[0]?.replicas).toBe(1);
    expect(d.services[0]?.healthCheck).toBeNull();
    expect(d.services[0]?.rollout.maxSurge).toBe(1);
    expect(d.services[0]?.ingress?.edge).toBe("edge-1");
  });

  it("rejects a pre-v2 desired.json (version 1 / ingress without an edge)", () => {
    const old = {
      version: 1,
      nodeId: "node-prod-1",
      updatedAt: "2026-06-04T00:00:00Z",
      services: [
        {
          project: "example-express",
          service: "web",
          image: "ecr/example-express/web:abc",
          cpu: 512,
          memory: 512,
          env: { NODE_ENV: "production" },
          ingress: { domain: "x.example.com", port: 3000 },
        },
      ],
    };
    expect(() => parseDesiredState(old)).toThrow();
  });

  it("parses a node.json without the newer optional fields (privateIp / clusterId / agentType)", () => {
    const minimal = {
      nodeId: "node-prod-1",
      instanceId: "i-123",
      instanceType: "t3.small",
      region: "us-east-1",
      availabilityZone: "us-east-1f",
      role: "edge",
      totalCpu: 2048,
      totalMemory: 2048,
      reservedCpu: 256,
      reservedMemory: 512,
      publicIp: "3.93.86.184",
      securityGroupId: "sg-1",
      iamInstanceProfile: "launch-pad-node-profile",
      agentId: "agent-node-prod-1",
      agentVersion: "0.0.0",
      createdAt: "2026-06-04T00:00:00Z",
      createdBy: "arn:aws:iam::1:user/x",
      state: "ready",
    };
    const n = parseNodeRegistryEntry(minimal);
    expect(n.privateIp).toBeNull();
    expect(n.eipAllocationId).toBeNull();
    // node.json without a clusterId belongs to the implicit default cluster.
    expect(n.clusterId).toBe("default");
    expect(n.agentType).toBe("ts");
  });

  it("parses legacy node.json with role both", () => {
    const legacy = {
      nodeId: "node-prod-1",
      instanceId: "i-123",
      instanceType: "t3.small",
      region: "us-east-1",
      availabilityZone: "us-east-1f",
      role: "both",
      totalCpu: 2048,
      totalMemory: 2048,
      reservedCpu: 256,
      reservedMemory: 512,
      publicIp: "3.93.86.184",
      securityGroupId: "sg-1",
      iamInstanceProfile: "launch-pad-node-profile",
      agentId: "agent-node-prod-1",
      agentVersion: "0.0.0",
      createdAt: "2026-06-04T00:00:00Z",
      createdBy: "arn:aws:iam::1:user/x",
      state: "ready",
    };
    expect(parseNodeRegistryEntry(legacy).role).toBe("both");
  });

  it("rejects a node.json without a role", () => {
    const old = {
      nodeId: "node-prod-1",
      instanceId: "i-123",
      instanceType: "t3.small",
      region: "us-east-1",
      availabilityZone: "us-east-1f",
      totalCpu: 2048,
      totalMemory: 2048,
      reservedCpu: 256,
      reservedMemory: 512,
      publicIp: "3.93.86.184",
      securityGroupId: "sg-1",
      iamInstanceProfile: "launch-pad-node-profile",
      agentId: "agent-node-prod-1",
      agentVersion: "0.0.0",
      createdAt: "2026-06-04T00:00:00Z",
      createdBy: "arn:aws:iam::1:user/x",
      state: "ready",
    };
    expect(() => parseNodeRegistryEntry(old)).toThrow();
  });

  it("parses an old status.json (no replicas / edgeRoutes)", () => {
    const old = {
      nodeId: "node-prod-1",
      agentId: "agent-node-prod-1",
      lastSeen: "2026-06-04T00:00:00Z",
      agentVersion: "0.0.0",
      services: [
        {
          project: "example-express",
          service: "web",
          image: "ecr/web:abc",
          state: "running",
          message: "running",
          containerId: "deadbeef",
          updatedAt: "2026-06-04T00:00:00Z",
        },
      ],
      caddy: { managed: true, lastReloadAt: null, error: null },
    };
    const s = parseNodeStatus(old);
    expect(s.services[0]?.replicas).toEqual([]);
    expect(s.services[0]?.desiredReplicas).toBe(0);
    expect(s.edgeRoutes).toEqual([]);
  });
});
