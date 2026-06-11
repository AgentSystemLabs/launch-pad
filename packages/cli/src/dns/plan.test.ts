import { describe, expect, it } from "vitest";
import { parseLaunchPadConfig } from "@agentsystemlabs/launch-pad-shared";
import { planDnsTargets, selectHostedZone } from "./plan";

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

describe("selectHostedZone", () => {
  const zones = [
    { id: "/hostedzone/ZAPEX", name: "example.com." },
    { id: "/hostedzone/ZSUB", name: "app.example.com." },
    { id: "/hostedzone/ZOTHER", name: "other.net." },
  ];

  it("picks the longest-suffix matching zone", () => {
    // app.example.com matches both example.com and app.example.com — the more specific wins.
    expect(selectHostedZone(zones, "api.app.example.com")?.id).toBe("/hostedzone/ZSUB");
    expect(selectHostedZone(zones, "www.example.com")?.id).toBe("/hostedzone/ZAPEX");
  });

  it("matches an apex domain equal to the zone name", () => {
    expect(selectHostedZone(zones, "example.com")?.id).toBe("/hostedzone/ZAPEX");
  });

  it("returns null when no zone is a suffix", () => {
    expect(selectHostedZone(zones, "nope.org")).toBeNull();
  });

  it("does not match a zone that is a substring but not a dot-boundary suffix", () => {
    // "notexample.com" must NOT match the "example.com" zone.
    expect(selectHostedZone(zones, "notexample.com")).toBeNull();
  });

  it("tolerates trailing dots and missing fields", () => {
    expect(selectHostedZone([{ id: "Z1", name: "example.com" }], "x.example.com.")?.id).toBe("Z1");
    expect(selectHostedZone([{ id: "", name: "example.com." }], "x.example.com")).toBeNull();
  });
});

describe("planDnsTargets", () => {
  it("skips workers (no domain/port) and includes web services", () => {
    const config = cfg([
      { name: "web", domain: "app.example.com", port: 3000, node: "node-1" },
      { name: "worker", node: "node-1" },
    ]);
    const targets = planDnsTargets(config, undefined, null);
    expect(targets).toEqual([{ service: "web", domain: "app.example.com", frontingNode: "node-1" }]);
  });

  it("co-locates a pinned web service on its own node", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000, node: "node-a" }]);
    expect(planDnsTargets(config, undefined, null)[0]?.frontingNode).toBe("node-a");
  });

  it("routes a service with an explicit edge through that edge", () => {
    const config = cfg([
      { name: "web", domain: "app.example.com", port: 3000, nodes: ["a", "b"], edge: "edge-1" },
    ]);
    expect(planDnsTargets(config, undefined, "cluster-edge")[0]?.frontingNode).toBe("edge-1");
  });

  it("uses the cluster default edge for a cluster-placed split/auto service", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000, topology: "split" }]);
    expect(planDnsTargets(config, undefined, "cluster-edge")[0]?.frontingNode).toBe("cluster-edge");
  });

  it("does NOT inherit the cluster default edge for a co-located cluster-placed service", () => {
    // topology = "co-located" serves the domain from the scheduler-picked node, which
    // is unknowable statically — never the cluster's default edge.
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000, topology: "co-located" }]);
    expect(planDnsTargets(config, undefined, "cluster-edge")[0]?.frontingNode).toBeNull();
  });

  it("returns frontingNode=null for a cluster-placed auto service with no cluster edge", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000 }]);
    expect(planDnsTargets(config, undefined, null)[0]?.frontingNode).toBeNull();
  });

  it("projects the domain for a deploy env", () => {
    const config = cfg([{ name: "web", domain: "app.example.com", port: 3000, node: "node-1" }]);
    expect(planDnsTargets(config, "staging", null)[0]?.domain).toBe("app-staging.example.com");
  });

  it("honors a domainPattern for env projection", () => {
    const config = cfg([
      { name: "web", domain: "app.example.com", port: 3000, node: "node-1", domainPattern: "{service}-{env}.example.com" },
    ]);
    expect(planDnsTargets(config, "pr-7", null)[0]?.domain).toBe("web-pr-7.example.com");
  });
});
