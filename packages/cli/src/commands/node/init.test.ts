import {
  DEFAULT_RESERVED_CPU,
  DEFAULT_RESERVED_MEMORY,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../../aws/context";
import { buildExternalNodeEntry, canResumeExternalInit, parseDetectedAdvertiseIp } from "./init";

// A minimal AwsEnv stub — buildExternalNodeEntry only reads clusterId/region/callerArn.
const aws = {
  clusterId: "default",
  region: "us-east-1",
  callerArn: "arn:aws:iam::123456789012:user/op",
} as unknown as AwsEnv;

describe("buildExternalNodeEntry", () => {
  it("stamps external (BYOS) markers and leaves every EC2 field null", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "byos-app-1",
      role: "app",
      cpu: 2048,
      memory: 4096,
      advertiseIp: "203.0.113.10",
      publicIp: null,
      iamUserName: "launch-pad-node-default-byos-app-1",
      agentVersion: "0.1.0",
    });

    expect(entry.provisioning).toBe("external");
    expect(entry.advertiseIp).toBe("203.0.113.10");
    expect(entry.iamUserName).toBe("launch-pad-node-default-byos-app-1");
    expect(entry.agentType).toBe("rust");
    expect(entry.state).toBe("provisioning");
    expect(entry.instanceType).toBe("external");

    // No managed EC2 footprint.
    expect(entry.instanceId).toBeNull();
    expect(entry.availabilityZone).toBeNull();
    expect(entry.privateIp).toBeNull();
    expect(entry.securityGroupId).toBeNull();
    expect(entry.iamInstanceProfile).toBeNull();
    expect(entry.eipAllocationId).toBeNull();

    // Identity carried through.
    expect(entry.nodeId).toBe("byos-app-1");
    expect(entry.clusterId).toBe("default");
    expect(entry.region).toBe("us-east-1");
    expect(entry.agentId).toBe("agent-byos-app-1");
    expect(entry.createdBy).toBe("arn:aws:iam::123456789012:user/op");
    expect(typeof entry.createdAt).toBe("string");

    // It's a valid, parseable registry entry.
    expect(() => parseNodeRegistryEntry(entry)).not.toThrow();
  });

  it("reserves host headroom identically to the EC2 path (same DEFAULT_RESERVED_* constants)", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "n",
      role: "app",
      cpu: 4096,
      memory: 8192,
      advertiseIp: "10.0.0.5",
      publicIp: null,
      iamUserName: "u",
      agentVersion: null,
    });
    expect(entry.totalCpu).toBe(4096);
    expect(entry.totalMemory).toBe(8192);
    expect(entry.reservedCpu).toBe(DEFAULT_RESERVED_CPU);
    expect(entry.reservedMemory).toBe(DEFAULT_RESERVED_MEMORY);
  });

  it("falls back to advertiseIp as the publicIp for an app node when --public-ip is absent", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "n",
      role: "app",
      cpu: 1024,
      memory: 1024,
      advertiseIp: "198.51.100.7",
      publicIp: null,
      iamUserName: "u",
      agentVersion: null,
    });
    expect(entry.publicIp).toBe("198.51.100.7");
  });

  it("uses an explicit --public-ip when given", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "n",
      role: "app",
      cpu: 1024,
      memory: 1024,
      advertiseIp: "10.0.0.9",
      publicIp: "198.51.100.42",
      iamUserName: "u",
      agentVersion: null,
    });
    expect(entry.publicIp).toBe("198.51.100.42");
  });

  it("records an external edge with a stable public IP and no advertiseIp", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "edge-home",
      role: "edge",
      cpu: 512,
      memory: 512,
      advertiseIp: null,
      publicIp: "203.0.113.50",
      iamUserName: "u",
      agentVersion: null,
    });

    expect(entry.role).toBe("edge");
    expect(entry.publicIp).toBe("203.0.113.50");
    expect(entry.advertiseIp).toBeNull();
    expect(entry.instanceId).toBeNull();
    expect(entry.eipAllocationId).toBeNull();
    expect(() => parseNodeRegistryEntry(entry)).not.toThrow();
  });
});

describe("parseDetectedAdvertiseIp", () => {
  it("uses the first non-loopback IPv4 token from ssh output", () => {
    expect(parseDetectedAdvertiseIp("10.0.1.50\n")).toBe("10.0.1.50");
    expect(parseDetectedAdvertiseIp("127.0.0.1 172.16.2.10\n")).toBe("172.16.2.10");
  });

  it("ignores malformed addresses", () => {
    expect(parseDetectedAdvertiseIp("not-an-ip 999.1.1.1 192.168.001.1")).toBeNull();
  });
});

describe("canResumeExternalInit", () => {
  it("allows retrying a bootstrapped external node that is still waiting for heartbeat", () => {
    const entry = buildExternalNodeEntry({
      aws,
      nodeId: "byos-app-1",
      role: "app",
      cpu: 1024,
      memory: 1024,
      advertiseIp: "198.51.100.7",
      publicIp: null,
      iamUserName: "u",
      agentVersion: null,
    });

    expect(canResumeExternalInit(entry)).toBe(true);
    expect(canResumeExternalInit({ ...entry, state: "ready" })).toBe(false);
    expect(canResumeExternalInit({ ...entry, provisioning: "ec2" })).toBe(false);
  });
});
