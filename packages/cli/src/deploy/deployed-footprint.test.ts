import { PROTOCOL_VERSION } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { loadDeployedFootprints } from "./deployed-footprint";

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
