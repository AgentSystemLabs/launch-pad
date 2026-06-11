import { describe, expect, it } from "vitest";
import { buildSetupPlan } from "./wizard";

const ACCOUNT = "493255580566";

describe("buildSetupPlan", () => {
  it("derives the account+region state bucket name", () => {
    const plan = buildSetupPlan(ACCOUNT, "us-east-1", "default");
    expect(plan.bucket).toBe(`launch-pad-state-${ACCOUNT}-us-east-1`);
    expect(plan.region).toBe("us-east-1");
    expect(plan.accountId).toBe(ACCOUNT);
  });

  it("treats the implicit default cluster as ambient (no local target saved)", () => {
    const plan = buildSetupPlan(ACCOUNT, "us-east-1", "default");
    expect(plan.isDefaultCluster).toBe(true);
    expect(plan.savesLocalTarget).toBe(false);
  });

  it("saves a local target for a named cluster", () => {
    const plan = buildSetupPlan(ACCOUNT, "us-west-2", "prod");
    expect(plan.isDefaultCluster).toBe(false);
    expect(plan.savesLocalTarget).toBe(true);
    expect(plan.cluster).toBe("prod");
    // The bucket is per account+region, NOT per cluster — same bucket as any other cluster here.
    expect(plan.bucket).toBe(`launch-pad-state-${ACCOUNT}-us-west-2`);
  });
});
