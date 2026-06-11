import { describe, expect, it } from "vitest";
import type { DesiredState } from "@agentsystemlabs/launch-pad-shared";
import type { ManagedReplica } from "./docker";
import { buildUpstreamShards } from "./upstream";

function desired(nodeId: string, edge: string): DesiredState {
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
        replicas: 2,
        env: {},
        secretRefs: [],
        ingress: { domain: "app.example.com", port: 3000, edge },
        healthCheck: { path: "/health", intervalMs: 10_000, timeoutMs: 3_000, healthyThreshold: 3 },
        rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
        volumes: [],
      },
    ],
  };
}

describe("buildUpstreamShards", () => {
  it("groups running replicas by edge with health paths", () => {
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
          {
            id: "c1",
            name: "n1",
            index: 1,
            project: "p",
            service: "web",
            image: "img",
            cpu: 256,
            memory: 256,
            state: "starting",
            hostPort: 20002,
            configStamp: "",
          },
        ],
      ],
    ]);

    const shards = buildUpstreamShards("app-1", "10.0.1.5", desired("app-1", "edge-1"), live);
    const shard = shards.get("edge-1");
    expect(shard?.privateIp).toBe("10.0.1.5");
    expect(shard?.backends).toEqual([
      { domain: "app.example.com", hostPort: 20001, healthPath: "/health" },
    ]);
  });

  it("excludes draining replicas so the edge stops routing to them before they stop", () => {
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
          {
            id: "c1",
            name: "n1",
            index: 1,
            project: "p",
            service: "web",
            image: "img",
            cpu: 256,
            memory: 256,
            state: "running",
            hostPort: 20002,
            configStamp: "",
          },
        ],
      ],
    ]);

    const shards = buildUpstreamShards(
      "app-1",
      "10.0.1.5",
      desired("app-1", "edge-1"),
      live,
      new Set(["c0"]),
    );
    expect(shards.get("edge-1")?.backends).toEqual([
      { domain: "app.example.com", hostPort: 20002, healthPath: "/health" },
    ]);
  });
});
