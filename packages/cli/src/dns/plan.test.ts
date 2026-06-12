import { describe, expect, it } from "vitest";
import { parseLaunchPadConfig } from "@agentsystemlabs/launch-pad-shared";
import { planDnsTargets } from "./plan";

/** Build a parsed config, filling the required cpu/memory (+ healthCheck for web) per service. */
function cfg(services: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const filled = services.map((s) => ({
    cpu: 256,
    memory: 256,
    ...(s.domain !== undefined ? { healthCheck: { path: "/healthz" } } : {}),
    ...s,
  }));
  return parseLaunchPadConfig({ project: "proj", service: filled, ...extra });
}

describe("planDnsTargets", () => {
  it("skips workers (no domain/port) and includes web services", () => {
    const config = cfg([
      { name: "web", domain: "app.example.com", port: 3000 },
      { name: "worker" },
    ]);
    const targets = planDnsTargets(config, undefined, "cluster-edge");
    expect(targets).toEqual([
      { service: "web", domain: "app.example.com", frontingNode: "cluster-edge" },
    ]);
  });

  it("fronts every web service with the cluster's dedicated edge", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000 }]);
    expect(planDnsTargets(config, undefined, "cluster-edge")[0]?.frontingNode).toBe("cluster-edge");
  });

  it("returns frontingNode=null when the cluster has no edge yet", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000 }]);
    expect(planDnsTargets(config, undefined, null)[0]?.frontingNode).toBeNull();
  });

  it("projects the domain for a deploy env", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000 }]);
    expect(planDnsTargets(config, "staging", null)[0]?.domain).toBe("app-staging.example.com");
  });

  it("honors a domainPattern for env projection", () => {
    const config = cfg([
      { name: "web", domain: "app.example.com", port: 3000, domainPattern: "{service}-{env}.example.com" },
    ]);
    expect(planDnsTargets(config, "pr-7", null)[0]?.domain).toBe("web-pr-7.example.com");
  });
});
