import { GetObjectCommand } from "@aws-sdk/client-s3";
import { type NodeStatus } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it, vi } from "vitest";
import { waitForConvergence, type WatchTarget } from "./watch";

function status(containerIds: string[]): NodeStatus {
  return {
    nodeId: "app-1",
    agentId: "agent-app-1",
    agentVersion: "0.0.0",
    lastSeen: new Date().toISOString(),
    caddy: { managed: false, lastReloadAt: null, error: null },
    edgeRoutes: [],
    services: [
      {
        project: "app",
        service: "web",
        image: "repo:web",
        state: "running",
        message: "",
        containerId: containerIds[0] ?? null,
        desiredReplicas: 2,
        runningReplicas: 2,
        updatedAt: new Date().toISOString(),
        replicas: containerIds.map((id, index) => ({
          index,
          containerId: id,
          hostPort: 20000 + index,
          state: "running",
          image: "repo:web",
          healthy: true,
        })),
      },
    ],
  };
}

function body(raw: unknown): { transformToString: () => Promise<string> } {
  return { transformToString: async () => JSON.stringify(raw) };
}

describe("waitForConvergence", () => {
  it("waits for restart deploys to replace old container ids even when image is unchanged", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Body: body(status(["old-a", "old-b"])) })
      .mockResolvedValueOnce({ Body: body(status(["new-a", "old-b"])) })
      .mockResolvedValueOnce({ Body: body(status(["new-a", "new-b"])) });
    const target: WatchTarget = {
      nodeId: "app-1",
      project: "app",
      service: "web",
      image: "repo:web",
      expectedReplicas: 2,
      previousContainerIds: ["old-a", "old-b"],
    };

    const results = await waitForConvergence({ send } as never, "bucket", "default", [target], 20_000);

    expect(results[0]?.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
  }, 15_000);

  it("converges immediately for normal image deploys without previous ids", async () => {
    const send = vi.fn().mockResolvedValue({ Body: body(status(["old-a", "old-b"])) });
    const target: WatchTarget = {
      nodeId: "app-1",
      project: "app",
      service: "web",
      image: "repo:web",
      expectedReplicas: 2,
    };

    const results = await waitForConvergence({ send } as never, "bucket", "default", [target], 20_000);

    expect(results[0]?.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
