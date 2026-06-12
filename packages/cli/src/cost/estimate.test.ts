import { describe, expect, it } from "vitest";
import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import {
  budgetVerdict,
  estimateAgentS3Monthly,
  estimateEc2Monthly,
  estimateProvisionCost,
  formatNodeMonthlyCost,
  formatProvisionCostSummary,
  HOURS_PER_MONTH,
  summarizeClusterCost,
} from "./estimate";

/** Minimal registry entry for the cost rollup (only the fields it reads). */
function entry(over: Partial<NodeRegistryEntry> & Pick<NodeRegistryEntry, "nodeId">): NodeRegistryEntry {
  return {
    instanceType: "t3.small",
    role: "app",
    state: "ready",
    totalCpu: 2048,
    totalMemory: 2048,
    reservedCpu: 256,
    reservedMemory: 512,
    ...over,
  } as NodeRegistryEntry;
}

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

describe("formatNodeMonthlyCost", () => {
  it("includes EC2 and S3 for a billing node", () => {
    const line = formatNodeMonthlyCost({
      nodeId: "app-1",
      role: "app",
      instanceType: "t3.small",
      billsEc2: true,
    });
    expect(line).toContain("/mo");
    expect(line).toContain("~$");
  });

  it("shows S3 only for sync-only repairs", () => {
    const line = formatNodeMonthlyCost({
      nodeId: "app-1",
      role: "app",
      instanceType: "t3.small",
      billsEc2: false,
    });
    expect(line).toContain("/mo");
    expect(line).not.toContain("unknown");
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
      { nodeId: "n1", role: "app", instanceType: "t3.small", billsEc2: false },
    ]);

    expect(est.ec2Lines).toHaveLength(0);
    expect(est.ec2TotalUsd).toBe(0);
    expect(est.s3ByNode).toHaveLength(1);
    expect(est.totalUsd).toBe(est.s3TotalUsd);
  });
});

describe("summarizeClusterCost", () => {
  it("estimates running nodes (EC2 + S3) and counts paused ones separately", () => {
    const summary = summarizeClusterCost([
      entry({ nodeId: "app-1", state: "ready", instanceType: "t3.small" }),
      entry({ nodeId: "app-2", state: "stopped", instanceType: "t3.small" }),
    ]);
    expect(summary.runningNodes).toBe(1);
    expect(summary.pausedNodes).toBe(1);
    // Only the running node is billed (the paused one's agent is off + compute isn't charged).
    expect(summary.estimate.ec2Lines.reduce((n, l) => n + l.count, 0)).toBe(1);
    expect(summary.estimate.s3ByNode).toHaveLength(1);
  });

  it("excludes terminated / terminating nodes entirely", () => {
    const summary = summarizeClusterCost([
      entry({ nodeId: "app-1", state: "ready" }),
      entry({ nodeId: "dead", state: "terminated" }),
      entry({ nodeId: "dying", state: "terminating" }),
    ]);
    expect(summary.runningNodes).toBe(1);
    expect(summary.pausedNodes).toBe(0);
    expect(summary.estimate.s3ByNode).toHaveLength(1);
  });

  it("counts a provisioning node as running (it bills from launch)", () => {
    const summary = summarizeClusterCost([entry({ nodeId: "app-1", state: "provisioning" })]);
    expect(summary.runningNodes).toBe(1);
  });
});

describe("budgetVerdict", () => {
  it("flags a footprint over budget with the overage", () => {
    const v = budgetVerdict(50, 30);
    expect(v.over).toBe(true);
    expect(v.overByUsd).toBeCloseTo(20, 2);
  });

  it("passes a footprint at or under budget", () => {
    expect(budgetVerdict(30, 30).over).toBe(false);
    expect(budgetVerdict(10, 30).over).toBe(false);
    expect(budgetVerdict(10, 30).overByUsd).toBe(0);
  });

  it("never flags over when the total is unknown (missing EC2 rate)", () => {
    const v = budgetVerdict(null, 30);
    expect(v.over).toBe(false);
    expect(v.totalUsd).toBeNull();
  });
});
