import { describe, expect, it } from "vitest";
import { parseDesiredState } from "./desired";
import { parseNodeRegistryEntry } from "./registry";
import { parseNodeStatus } from "./status";

// These fixtures mirror the shapes live on node-prod-1 BEFORE this feature.
// Every new field must default so they keep parsing.

describe("backward compatibility with pre-feature S3 documents", () => {
  it("parses an old desired.json (no replicas / healthCheck / rollout / ingress.edge)", () => {
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
    const d = parseDesiredState(old);
    expect(d.services[0]?.replicas).toBe(1);
    expect(d.services[0]?.healthCheck).toBeNull();
    expect(d.services[0]?.rollout.maxSurge).toBe(1);
    expect(d.services[0]?.ingress?.edge).toBeNull();
  });

  it("parses an old node.json (no role / privateIp)", () => {
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
      eipAllocationId: "eipalloc-1",
      securityGroupId: "sg-1",
      iamInstanceProfile: "launch-pad-node-profile",
      agentId: "agent-node-prod-1",
      agentVersion: "0.0.0",
      createdAt: "2026-06-04T00:00:00Z",
      createdBy: "arn:aws:iam::1:user/x",
      state: "ready",
    };
    const n = parseNodeRegistryEntry(old);
    expect(n.role).toBe("both");
    expect(n.privateIp).toBeNull();
    // pre-cluster node.json has no clusterId → it belongs to the implicit default cluster.
    expect(n.clusterId).toBe("default");
    // pre-golden-AMI nodes ran the TypeScript bundle.
    expect(n.agentType).toBe("ts");
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
