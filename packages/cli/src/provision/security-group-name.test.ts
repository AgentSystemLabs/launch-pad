import { describe, expect, it } from "vitest";
import { DEFAULT_CLUSTER } from "@agentsystemlabs/launch-pad-shared";
import { legacySecurityGroupName, securityGroupName } from "./provision-node";

describe("securityGroupName cluster scoping", () => {
  it("keeps the default cluster un-prefixed (legacy, no migration)", () => {
    expect(securityGroupName("edge-1", DEFAULT_CLUSTER)).toBe("launch-pad-edge-1-sg");
    expect(securityGroupName("edge-1", DEFAULT_CLUSTER)).toBe(legacySecurityGroupName("edge-1"));
  });

  it("prefixes named clusters so per-cluster SGs are distinct", () => {
    expect(securityGroupName("edge-1", "swarm")).toBe("launch-pad-swarm-edge-1-sg");
  });

  it("two clusters that both auto-name their edge `edge-1` get DIFFERENT SG names", () => {
    // This is the regression: every cluster's auto-provisioned edge is `edge-1`,
    // so before scoping both resolved to the same `launch-pad-edge-1-sg` and the
    // second deploy hijacked the first cluster's edge SG (and EIP).
    const a = securityGroupName("edge-1", DEFAULT_CLUSTER);
    const b = securityGroupName("edge-1", "swarm-verify");
    const c = securityGroupName("edge-1", "coffee-shop");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("legacySecurityGroupName is always the un-prefixed name", () => {
    expect(legacySecurityGroupName("edge-1")).toBe("launch-pad-edge-1-sg");
    expect(legacySecurityGroupName("shark-roams-easily")).toBe("launch-pad-shark-roams-easily-sg");
  });
});
