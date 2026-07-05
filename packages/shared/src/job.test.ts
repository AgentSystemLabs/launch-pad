import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./constants";
import { parseDesiredState } from "./desired";
import { parseNodeStatus } from "./status";

describe("one-off job run wire contract", () => {
  it("parses a transient desired jobRun request", () => {
    const desired = parseDesiredState({
      version: PROTOCOL_VERSION,
      nodeId: "app-1",
      updatedAt: "2026-07-02T00:00:00.000Z",
      services: [
        {
          project: "shop",
          service: "migrate",
          image: "repo/migrate:tag",
          cpu: 256,
          memory: 128,
          replicas: 1,
          env: {},
          secretRefs: [],
          ingress: null,
          healthCheck: null,
          rollout: {},
          volumes: [],
          jobRun: { id: "run-1", requestedAt: "2026-07-02T00:00:00.000Z" },
        },
      ],
    });

    expect(desired.services[0]?.jobRun?.id).toBe("run-1");
  });

  it("parses a terminal jobRun status result", () => {
    const status = parseNodeStatus({
      nodeId: "app-1",
      agentId: "agent-app-1",
      lastSeen: "2026-07-02T00:00:05.000Z",
      agentVersion: "0.2.0",
      services: [
        {
          project: "shop",
          service: "migrate",
          image: "repo/migrate:tag",
          state: "stopped",
          message: "job run succeeded",
          replicas: [],
          desiredReplicas: 0,
          runningReplicas: 0,
          jobRun: {
            id: "run-1",
            requestedAt: "2026-07-02T00:00:00.000Z",
            startedAt: "2026-07-02T00:00:00.000Z",
            finishedAt: "2026-07-02T00:00:05.000Z",
            exitCode: 0,
            state: "succeeded",
            message: "job run succeeded",
          },
          updatedAt: "2026-07-02T00:00:05.000Z",
        },
      ],
      caddy: { managed: false, lastReloadAt: null, error: null },
      edgeRoutes: [],
    });

    expect(status.services[0]?.jobRun?.state).toBe("succeeded");
    expect(status.services[0]?.jobRun?.exitCode).toBe(0);
  });
});
