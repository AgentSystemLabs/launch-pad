import { describe, expect, it } from "vitest";
import { nodeUsesElasticIp, parseNodeRegistryEntry } from "./registry";

describe("nodeUsesElasticIp", () => {
  it("edge nodes get a stable public IP", () => {
    expect(nodeUsesElasticIp("edge")).toBe(true);
  });

  it("legacy both nodes get a stable public IP", () => {
    expect(nodeUsesElasticIp("both")).toBe(true);
  });

  it("app nodes are VPC-private only", () => {
    expect(nodeUsesElasticIp("app")).toBe(false);
  });
});

describe("parseNodeRegistryEntry — provisioning / BYOS fields", () => {
  // A node.json written before the BYOS fields existed (no provisioning/advertiseIp/iamUserName).
  const legacyEc2 = {
    nodeId: "app-1",
    clusterId: "default",
    instanceId: "i-0abc",
    instanceType: "t3.small",
    region: "us-east-1",
    availabilityZone: "us-east-1a",
    role: "app",
    privateIp: "10.0.0.5",
    totalCpu: 2048,
    totalMemory: 4096,
    reservedCpu: 256,
    reservedMemory: 512,
    publicIp: null,
    eipAllocationId: null,
    securityGroupId: "sg-0abc",
    iamInstanceProfile: "launch-pad-node",
    agentId: "agent-app-1",
    agentVersion: "0.1.0",
    agentType: "rust",
    createdAt: "2026-06-01T00:00:00Z",
    createdBy: "arn:aws:iam::111111111111:user/op",
    state: "ready",
  };

  it("defaults a legacy node.json to provisioning=ec2 with null advertiseIp/iamUserName", () => {
    const node = parseNodeRegistryEntry(legacyEc2);
    expect(node.provisioning).toBe("ec2");
    expect(node.advertiseIp).toBeNull();
    expect(node.iamUserName).toBeNull();
  });

  it("parses an external (BYOS) entry with advertiseIp and iamUserName set", () => {
    const node = parseNodeRegistryEntry({
      ...legacyEc2,
      nodeId: "byos-1",
      instanceId: null,
      instanceType: "external",
      availabilityZone: null,
      privateIp: null,
      securityGroupId: null,
      iamInstanceProfile: null,
      eipAllocationId: null,
      provisioning: "external",
      advertiseIp: "203.0.113.10",
      iamUserName: "launch-pad-node-default-byos-1",
    });
    expect(node.provisioning).toBe("external");
    expect(node.advertiseIp).toBe("203.0.113.10");
    expect(node.iamUserName).toBe("launch-pad-node-default-byos-1");
  });
});
