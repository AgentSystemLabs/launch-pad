import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "./desired";
import { mergeProjectServices, mergeProjectServicesPartial } from "./merge";

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
    volumes: [],
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

describe("mergeProjectServicesPartial — subset (partial) deploy", () => {
  it("upserts only the incoming services, PRESERVING the project's co-located siblings", () => {
    // The core fix: deploying just `blog/web` must NOT drop the co-located `blog/worker`.
    const existing = [svc("blog", "web"), svc("blog", "worker"), svc("shop", "web")];
    const incoming = [svc("blog", "web", 512, 512)];

    const merged = mergeProjectServicesPartial(existing, "blog", incoming);

    // blog/worker (a co-located sibling not in this deploy) is KEPT — unlike the
    // full-replace mergeProjectServices, which drops it.
    expect(merged.find((s) => s.project === "blog" && s.service === "worker")).toBeDefined();
    // blog/web replaced in place with the new sizing.
    expect(merged.find((s) => s.project === "blog" && s.service === "web")?.cpu).toBe(512);
    // shop untouched.
    expect(merged.find((s) => s.project === "shop" && s.service === "web")).toBeDefined();
    expect(merged).toHaveLength(3);
  });

  it("preserves existing order, replacing matched services in place", () => {
    const existing = [svc("blog", "web"), svc("blog", "worker")];
    const merged = mergeProjectServicesPartial(existing, "blog", [svc("blog", "worker", 1024, 1024)]);
    expect(merged.map((s) => s.service)).toEqual(["web", "worker"]);
    expect(merged[1]?.cpu).toBe(1024);
  });

  it("appends a brand-new service to the project's footprint without touching siblings", () => {
    const existing = [svc("blog", "web"), svc("shop", "web")];
    const merged = mergeProjectServicesPartial(existing, "blog", [svc("blog", "api")]);
    expect(merged.map((s) => `${s.project}/${s.service}`)).toEqual(["blog/web", "shop/web", "blog/api"]);
  });

  it("adds a brand-new project's service to an occupied node", () => {
    const merged = mergeProjectServicesPartial([svc("shop", "web")], "blog", [svc("blog", "web")]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const existing = [svc("blog", "web"), svc("blog", "worker")];
    mergeProjectServicesPartial(existing, "blog", [svc("blog", "web", 512, 512)]);
    expect(existing).toHaveLength(2);
    expect(existing[0]?.cpu).toBe(256);
  });

  it("throws if incoming contains a foreign-owned service", () => {
    expect(() => mergeProjectServicesPartial([], "blog", [svc("shop", "web")])).toThrow(
      /not owned by project/,
    );
  });

  it("throws on duplicate keys within incoming", () => {
    expect(() =>
      mergeProjectServicesPartial([], "blog", [svc("blog", "web"), svc("blog", "web")]),
    ).toThrow(/duplicate service/);
  });
});
