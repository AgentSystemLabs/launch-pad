import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "./desired";
import { mergeProjectServices } from "./merge";

function svc(project: string, service: string, cpu = 256, memory = 256): ServiceConfig {
  return {
    project,
    service,
    image: `ecr/${project}/${service}:abc`,
    cpu,
    memory,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
  };
}

describe("mergeProjectServices", () => {
  it("replaces only the deploying project's services, keeping others", () => {
    const existing = [svc("blog", "web"), svc("blog", "worker"), svc("shop", "web")];
    const incoming = [svc("blog", "web", 512, 512)]; // blog now has only one service

    const merged = mergeProjectServices(existing, "blog", incoming);

    // shop untouched
    expect(merged.find((s) => s.project === "shop" && s.service === "web")).toBeDefined();
    // blog/worker dropped (no longer in incoming)
    expect(merged.find((s) => s.project === "blog" && s.service === "worker")).toBeUndefined();
    // blog/web replaced with the new sizing
    expect(merged.find((s) => s.project === "blog" && s.service === "web")?.cpu).toBe(512);
    expect(merged).toHaveLength(2);
  });

  it("adds a brand-new project's services to an occupied node", () => {
    const existing = [svc("shop", "web")];
    const merged = mergeProjectServices(existing, "blog", [svc("blog", "web")]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const existing = [svc("shop", "web")];
    mergeProjectServices(existing, "blog", [svc("blog", "web")]);
    expect(existing).toHaveLength(1);
  });

  it("throws if incoming contains a foreign-owned service", () => {
    expect(() => mergeProjectServices([], "blog", [svc("shop", "web")])).toThrow(
      /not owned by project/,
    );
  });

  it("throws on duplicate keys within incoming", () => {
    expect(() => mergeProjectServices([], "blog", [svc("blog", "web"), svc("blog", "web")])).toThrow(
      /duplicate service/,
    );
  });
});
