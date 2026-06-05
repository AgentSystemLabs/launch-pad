import { describe, expect, it } from "vitest";
import {
  estimateAgentS3Monthly,
  estimateEc2Monthly,
  estimateProvisionCost,
  formatProvisionCostSummary,
  HOURS_PER_MONTH,
} from "./estimate";

describe("estimateAgentS3Monthly", () => {
  it("counts desired.json GETs for app/both and status PUTs for all roles", () => {
    const app = estimateAgentS3Monthly("app", { pollMs: 10_000, livenessMs: 30_000 });
    const edge = estimateAgentS3Monthly("edge", { pollMs: 10_000, livenessMs: 30_000 });

    expect(app.getObjectsPerMonth).toBe(259_200);
    expect(app.putObjectsPerMonth).toBe(86_400);
    expect(edge.getObjectsPerMonth).toBe(0);
    expect(edge.putObjectsPerMonth).toBe(86_400);
    expect(app.totalUsd).toBeGreaterThan(0);
    expect(app.putCostUsd).toBeGreaterThan(app.getCostUsd);
  });
});

describe("estimateEc2Monthly", () => {
  it("uses the on-demand hourly table", () => {
    expect(estimateEc2Monthly("t3.small")).toBeCloseTo(0.0208 * HOURS_PER_MONTH, 2);
    expect(estimateEc2Monthly("unknown.type")).toBeNull();
  });
});

describe("estimateProvisionCost", () => {
  it("aggregates EC2 and S3 for provisioned nodes", () => {
    const est = estimateProvisionCost([
      { nodeId: "app-1", role: "app", instanceType: "t3.small", billsEc2: true },
      { nodeId: "edge-1", role: "edge", instanceType: "t3.micro", billsEc2: true },
    ]);

    expect(est.ec2Lines).toHaveLength(2);
    expect(est.ec2TotalUsd).not.toBeNull();
    expect(est.s3ByNode).toHaveLength(2);
    expect(est.s3GetObjectsPerMonth).toBeGreaterThan(0);
    expect(est.s3PutObjectsPerMonth).toBe(172_800);
    expect(est.totalUsd).not.toBeNull();
    expect(formatProvisionCostSummary(est)).toContain("/mo");
  });

  it("skips EC2 for sync-only repairs but still estimates agent S3", () => {
    const est = estimateProvisionCost([
      { nodeId: "n1", role: "both", instanceType: "t3.small", billsEc2: false },
    ]);

    expect(est.ec2Lines).toHaveLength(0);
    expect(est.ec2TotalUsd).toBe(0);
    expect(est.s3ByNode).toHaveLength(1);
    expect(est.totalUsd).toBe(est.s3TotalUsd);
  });
});
