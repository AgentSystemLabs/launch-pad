import { describe, expect, it } from "vitest";
import type { DesiredState } from "@agentsystemlabs/launch-pad-shared";
import type { ManagedReplica } from "./docker";
import { buildCoLocatedRoutes, isCoLocatedIngress, mergeRoutesByDomain } from "./routes";

function desired(nodeId: string, edge: string | null): DesiredState {
  return {
    version: 1,
    nodeId,
    updatedAt: "t",
    services: [
      {
        project: "p",
        service: "web",
        image: "img",
        cpu: 256,
        memory: 256,
        replicas: 1,
        env: {},
        secretRefs: [],
        ingress: { domain: "app.example.com", port: 3000, edge },
        healthCheck: null,
        rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
        volumes: [],
      },
    ],
  };
}

describe("isCoLocatedIngress", () => {
  it("treats null edge and self edge as co-located", () => {
    expect(isCoLocatedIngress("node-1", null)).toBe(true);
    expect(isCoLocatedIngress("node-1", "node-1")).toBe(true);
    expect(isCoLocatedIngress("node-1", "edge-1")).toBe(false);
  });
});

describe("buildCoLocatedRoutes", () => {
  it("routes co-located services to 127.0.0.1", () => {
    const live = new Map<string, ManagedReplica[]>([
      [
        "p/web",
        [
          {
            id: "c0",
            name: "n0",
            index: 0,
            project: "p",
            service: "web",
            image: "img",
            cpu: 256,
            memory: 256,
            state: "running",
            hostPort: 20001,
            configStamp: "",
          },
        ],
      ],
    ]);
    const routes = buildCoLocatedRoutes("node-1", desired("node-1", "node-1"), live);
    expect(routes).toEqual([
      { domain: "app.example.com", upstreams: ["127.0.0.1:20001"], healthPath: undefined },
    ]);
  });
});

describe("mergeRoutesByDomain", () => {
  it("unions upstreams for the same domain", () => {
    const merged = mergeRoutesByDomain([
      { domain: "a.com", upstreams: ["10.0.0.1:1"], healthPath: "/h" },
      { domain: "a.com", upstreams: ["10.0.0.2:2"] },
    ]);
    expect(merged).toEqual([
      { domain: "a.com", upstreams: ["10.0.0.1:1", "10.0.0.2:2"], healthPath: "/h" },
    ]);
  });
});
