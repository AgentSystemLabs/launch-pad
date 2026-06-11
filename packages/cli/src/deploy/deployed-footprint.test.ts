import { PROTOCOL_VERSION, type ServiceConfig } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { buildPlacementSnapshot, loadDeployedFootprints } from "./deployed-footprint";

function svcConfig(over: Partial<ServiceConfig>): ServiceConfig {
  return {
    project: "shop",
    service: "web",
    image: "img:1",
    cpu: 256,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    ...over,
  };
}

describe("buildPlacementSnapshot", () => {
  it("keeps per-node replica counts and sorts occupiedNodeIds", () => {
    const snapshot = buildPlacementSnapshot(
      [
        { nodeId: "node-b", services: [svcConfig({ replicas: 3 })] },
        { nodeId: "node-a", services: [svcConfig({ replicas: 1 }), svcConfig({ service: "worker" })] },
      ],
      "shop",
    );

    expect(snapshot.occupiedNodeIds).toEqual(["node-a", "node-b"]);
    expect(snapshot.byNode.get("node-b")).toEqual([
      { service: "web", replicas: 3, ingress: null },
    ]);
    expect(snapshot.byNode.get("node-a")).toEqual([
      { service: "web", replicas: 1, ingress: null },
      { service: "worker", replicas: 1, ingress: null },
    ]);
    // the aggregate view still sums replicas across nodes
    expect(snapshot.footprints).toEqual([
      expect.objectContaining({ service: "web", replicas: 4, nodeIds: ["node-a", "node-b"] }),
      expect.objectContaining({ service: "worker", replicas: 1, nodeIds: ["node-a"] }),
    ]);
  });

  it("ignores other projects' services", () => {
    const snapshot = buildPlacementSnapshot(
      [{ nodeId: "node-a", services: [svcConfig({ project: "other" })] }],
      "shop",
    );
    expect(snapshot.occupiedNodeIds).toEqual([]);
    expect(snapshot.footprints).toEqual([]);
    expect(snapshot.byNode.size).toBe(0);
  });
});

describe("loadDeployedFootprints", () => {
  it("aggregates replicas and node ids per service across nodes", async () => {
    const s3 = {
      send: async (command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
        if (command.constructor.name === "ListObjectsV2Command") {
          return {
            CommonPrefixes: [{ Prefix: "nodes/node-a/" }, { Prefix: "nodes/node-b/" }],
          };
        }
        if (command.constructor.name === "GetObjectCommand") {
          const key = command.input?.Key as string;
          const nodeId = key.includes("node-a") ? "node-a" : "node-b";
          const body = {
            version: PROTOCOL_VERSION,
            nodeId,
            updatedAt: "now",
            services: [
              {
                project: "edge-express-web",
                service: "web",
                image: "img:1",
                cpu: 256,
                memory: 256,
                replicas: 1,
                env: {},
                ingress: { domain: "app.example.com", port: 3000, edge: "edge-1" },
                healthCheck: { path: "/healthz" },
                rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
              },
            ],
          };
          return { Body: { transformToString: async () => JSON.stringify(body) } };
        }
        throw new Error(`unexpected command ${command.constructor.name}`);
      },
    };

    const footprints = await loadDeployedFootprints(
      s3 as never,
      "bucket",
      "default",
      "edge-express-web",
    );

    expect(footprints).toEqual([
      expect.objectContaining({
        service: "web",
        nodeIds: ["node-a", "node-b"],
        replicas: 2,
      }),
    ]);
  });
});
