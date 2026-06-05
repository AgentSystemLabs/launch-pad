import type { InstanceCapacity, NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { planResizedEntry, type ResizeNetwork } from "./resize-plan";

const base: NodeRegistryEntry = {
  nodeId: "node-1",
  clusterId: "default",
  instanceId: "i-abc",
  instanceType: "t3.small",
  region: "us-east-1",
  availabilityZone: "us-east-1a",
  role: "both",
  privateIp: "10.0.0.1",
  totalCpu: 2048,
  totalMemory: 2048,
  reservedCpu: 256,
  reservedMemory: 256,
  publicIp: "1.2.3.4",
  eipAllocationId: "eipalloc-1",
  securityGroupId: "sg-1",
  iamInstanceProfile: "profile-1",
  agentId: "agent-node-1",
  agentVersion: "0.1.0",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "arn:aws:iam::123:user/me",
  state: "ready",
};

// t3.large
const capacity: InstanceCapacity = { totalCpu: 2048, totalMemory: 8192 };
const newNet: ResizeNetwork = {
  publicIp: "9.9.9.9",
  privateIp: "10.0.0.2",
  availabilityZone: "us-east-1a",
};

describe("planResizedEntry", () => {
  it("always updates instanceType and capacity", () => {
    const out = planResizedEntry({ node: base, instanceType: "t3.large", capacity, restarted: true, network: newNet });
    expect(out.instanceType).toBe("t3.large");
    expect(out.totalCpu).toBe(2048);
    expect(out.totalMemory).toBe(8192);
  });

  it("edge/both with an Elastic IP keeps its stable public IP and becomes ready", () => {
    const out = planResizedEntry({ node: base, instanceType: "t3.large", capacity, restarted: true, network: newNet });
    expect(out.publicIp).toBe("1.2.3.4"); // EIP survives the resize, not the ephemeral 9.9.9.9
    expect(out.privateIp).toBe("10.0.0.2");
    expect(out.state).toBe("ready");
  });

  it("edge/both WITHOUT an Elastic IP picks up the fresh ephemeral public IP", () => {
    const noEip: NodeRegistryEntry = { ...base, eipAllocationId: null };
    const out = planResizedEntry({ node: noEip, instanceType: "t3.large", capacity, restarted: true, network: newNet });
    expect(out.publicIp).toBe("9.9.9.9");
  });

  it("app node stays VPC-private (no public IP) and refreshes its private IP", () => {
    const app: NodeRegistryEntry = { ...base, role: "app", publicIp: null, eipAllocationId: null };
    const out = planResizedEntry({ node: app, instanceType: "t3.large", capacity, restarted: true, network: newNet });
    expect(out.publicIp).toBeNull();
    expect(out.privateIp).toBe("10.0.0.2");
  });

  it("a paused node (not restarted) stays stopped at the new size", () => {
    const paused: NodeRegistryEntry = { ...base, state: "stopped" };
    const out = planResizedEntry({ node: paused, instanceType: "t3.large", capacity, restarted: false });
    expect(out.state).toBe("stopped");
    expect(out.instanceType).toBe("t3.large");
    expect(out.totalMemory).toBe(8192);
    expect(out.publicIp).toBe("1.2.3.4"); // EIP persists even while stopped
  });

  it("a paused node without an Elastic IP drops its ephemeral public IP", () => {
    const paused: NodeRegistryEntry = { ...base, state: "stopped", eipAllocationId: null };
    const out = planResizedEntry({ node: paused, instanceType: "t3.large", capacity, restarted: false });
    expect(out.publicIp).toBeNull();
    expect(out.state).toBe("stopped");
  });

  it("falls back to the old private IP / null network when none is observed on restart", () => {
    const out = planResizedEntry({ node: base, instanceType: "t3.large", capacity, restarted: true });
    expect(out.privateIp).toBe("10.0.0.1"); // kept from the entry
    expect(out.publicIp).toBe("1.2.3.4"); // EIP
    expect(out.availabilityZone).toBeNull();
  });
});
