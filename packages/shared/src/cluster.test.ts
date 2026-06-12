import { describe, expect, it } from "vitest";
import { parseClusterConfig } from "./cluster";

describe("parseClusterConfig", () => {
  it("parses a cluster.json and defaults defaultEdge to null", () => {
    const c = parseClusterConfig({
      clusterId: "lower",
      region: "us-east-1",
      createdAt: "2026-06-04T00:00:00Z",
      createdBy: "arn:aws:iam::1:user/x",
    });
    expect(c.clusterId).toBe("lower");
    expect(c.defaultEdge).toBeNull();
  });

  it("keeps an explicit defaultEdge", () => {
    const c = parseClusterConfig({
      clusterId: "lower",
      defaultEdge: "edge-lower",
      region: "us-east-1",
      createdAt: "t",
      createdBy: "x",
    });
    expect(c.defaultEdge).toBe("edge-lower");
  });

  it("defaults autoscale to null on pre-autoscale documents", () => {
    const c = parseClusterConfig({
      clusterId: "lower",
      region: "us-east-1",
      createdAt: "t",
      createdBy: "x",
    });
    expect(c.autoscale).toBeNull();
  });

  it("parses an autoscale policy with defaults", () => {
    const c = parseClusterConfig({
      clusterId: "lower",
      region: "us-east-1",
      createdAt: "t",
      createdBy: "x",
      autoscale: { minNodes: 1, maxNodes: 3 },
    });
    expect(c.autoscale).toMatchObject({ minNodes: 1, maxNodes: 3, scaleOutPercent: 80, scaleInPercent: 30 });
  });

  it("rejects unknown keys", () => {
    expect(() =>
      parseClusterConfig({ clusterId: "lower", region: "us-east-1", createdAt: "t", createdBy: "x", extra: 1 }),
    ).toThrow();
  });
});
