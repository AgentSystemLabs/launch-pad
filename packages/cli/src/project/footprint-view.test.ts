import { describe, expect, it } from "vitest";
import {
  parsePreviewMarker,
  parseProjectIndex,
  type PreviewMarker,
  type ProjectIndex,
  type ServiceConfig,
} from "@agentsystemlabs/launch-pad-shared";
import {
  buildFootprintList,
  buildEnvFootprintSummaries,
  buildProjectComponentViews,
  describeEnvMarker,
  describeMarkerExpiry,
  resolveFootprintOwner,
  summarizeFootprintServices,
} from "./footprint-view";

function svc(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    project: "shop-pr-1",
    service: "web",
    image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/web:abc",
    cpu: 256,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: { domain: "pr-1.example.com", port: 3000, edge: "edge-1" },
    healthCheck: { path: "/healthz", intervalMs: 5000, timeoutMs: 3000, healthyThreshold: 2 },
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
    ...over,
  };
}

function marker(over: Partial<PreviewMarker> = {}): PreviewMarker {
  return parsePreviewMarker({
    version: 1,
    project: "shop",
    env: "pr-1",
    owner: "shop-pr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    expiresAt: null,
    domains: ["pr-1.example.com"],
    ...over,
  });
}

describe("describeMarkerExpiry", () => {
  const nowMs = Date.parse("2026-06-12T00:00:00.000Z");

  it("reports no TTL when expiresAt is null", () => {
    expect(describeMarkerExpiry(marker(), nowMs)).toBe("no TTL");
  });

  it("reports expires when the marker is still valid", () => {
    expect(describeMarkerExpiry(marker({ expiresAt: "2026-12-01T00:00:00.000Z" }), nowMs)).toBe(
      "expires 2026-12-01T00:00:00.000Z",
    );
  });

  it("reports EXPIRED when past the TTL", () => {
    expect(describeMarkerExpiry(marker({ expiresAt: "2026-06-01T00:00:00.000Z" }), nowMs)).toBe(
      "EXPIRED 2026-06-01T00:00:00.000Z",
    );
  });
});

describe("describeEnvMarker", () => {
  const nowMs = Date.parse("2026-06-12T00:00:00.000Z");

  it("joins project, env, and expiry with separators", () => {
    expect(describeEnvMarker(marker({ expiresAt: "2026-12-01T00:00:00.000Z" }), nowMs)).toBe(
      "shop · env pr-1 · expires 2026-12-01T00:00:00.000Z",
    );
  });
});

describe("summarizeFootprintServices", () => {
  it("aggregates replicas and node ids per service for one footprint owner", () => {
    expect(
      summarizeFootprintServices(
        [
          { nodeId: "node-b", services: [svc({ replicas: 2 })] },
          {
            nodeId: "node-a",
            services: [svc({ replicas: 1, service: "worker", ingress: null, healthCheck: null, cron: "0 * * * *" })],
          },
        ],
        "shop-pr-1",
      ),
    ).toEqual([
      {
        service: "web",
        replicas: 2,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/web:abc",
        domain: "pr-1.example.com",
        nodeIds: ["node-b"],
      },
      {
        service: "worker",
        replicas: 1,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/web:abc",
        domain: null,
        cron: "0 * * * *",
        nodeIds: ["node-a"],
      },
    ]);
  });
});

describe("buildFootprintList", () => {
  it("lists base and env footprints with node placement", () => {
    const nowMs = Date.parse("2026-06-12T00:00:00.000Z");
    const list = buildFootprintList(
      [marker()],
      [
        { nodeId: "node-a", services: [svc({ project: "shop" })] },
        { nodeId: "node-b", services: [svc()] },
      ],
      nowMs,
    );

    expect(list).toEqual([
      expect.objectContaining({
        owner: "shop",
        baseProject: "shop",
        env: null,
        nodeIds: ["node-a"],
        services: [expect.objectContaining({ service: "web", nodeIds: ["node-a"] })],
      }),
      expect.objectContaining({
        owner: "shop-pr-1",
        baseProject: "shop",
        env: "pr-1",
        nodeIds: ["node-b"],
      }),
    ]);
  });

  it("includes marker-only env footprints with no scheduled services", () => {
    const list = buildFootprintList([marker()], [], Date.now());
    expect(list).toEqual([
      expect.objectContaining({ owner: "shop-pr-1", env: "pr-1", services: [], nodeIds: [] }),
    ]);
  });

  it("joins derived component owners back to (project, component) via the index", () => {
    const list = buildFootprintList(
      [],
      [
        { nodeId: "node-a", services: [svc({ project: "shop--auth", service: "auth" })] },
        { nodeId: "node-b", services: [svc({ project: "shop--notes", service: "notes" })] },
        { nodeId: "node-b", services: [svc({ project: "legacy" })] },
      ],
      Date.now(),
      [federatedIndex()],
    );
    expect(list).toEqual([
      expect.objectContaining({ owner: "legacy", baseProject: "legacy", component: null }),
      expect.objectContaining({ owner: "shop--auth", baseProject: "shop", component: "auth" }),
      expect.objectContaining({ owner: "shop--notes", baseProject: "shop", component: "notes" }),
    ]);
  });
});

function federatedIndex(): ProjectIndex {
  return parseProjectIndex({
    version: 1,
    project: "shop",
    components: [
      { component: "auth", owner: "shop--auth", services: ["auth"], updatedAt: "2026-01-01T00:00:00.000Z" },
      { component: "notes", owner: "shop--notes", services: ["notes"], updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("buildProjectComponentViews", () => {
  const states = [
    { nodeId: "node-a", services: [svc({ project: "shop--auth", service: "auth" })] },
    { nodeId: "node-b", services: [svc({ project: "shop--notes", service: "notes" })] },
    { nodeId: "node-b", services: [svc({ project: "shop--auth-pr-1", service: "auth" })] },
  ];

  it("aggregates each component's base footprint", () => {
    const views = buildProjectComponentViews(federatedIndex(), states, undefined);
    expect(views).toEqual([
      expect.objectContaining({ component: "auth", owner: "shop--auth", nodeIds: ["node-a"] }),
      expect.objectContaining({ component: "notes", owner: "shop--notes", nodeIds: ["node-b"] }),
    ]);
    expect(views[0]?.services).toEqual([expect.objectContaining({ service: "auth" })]);
  });

  it("projects each component's owner through an env", () => {
    const views = buildProjectComponentViews(federatedIndex(), states, "pr-1");
    expect(views[0]).toEqual(
      expect.objectContaining({ component: "auth", owner: "shop--auth-pr-1", nodeIds: ["node-b"] }),
    );
    // notes has no pr-1 footprint — empty, not an error.
    expect(views[1]).toEqual(expect.objectContaining({ component: "notes", services: [], nodeIds: [] }));
  });
});

describe("resolveFootprintOwner", () => {
  it("maps base project and env to the desired.json owner", () => {
    expect(resolveFootprintOwner("auth-example", undefined)).toBe("auth-example");
    expect(resolveFootprintOwner("auth-example", "pr-1")).toBe("auth-example-pr-1");
  });
});

describe("buildEnvFootprintSummaries", () => {
  it("marks expired env markers", () => {
    const nowMs = Date.parse("2026-06-12T00:00:00.000Z");
    expect(
      buildEnvFootprintSummaries(
        [marker({ expiresAt: "2026-06-01T00:00:00.000Z" })],
        [{ nodeId: "node-a", services: [svc()] }],
        nowMs,
      )[0]?.expired,
    ).toBe(true);
  });
});
