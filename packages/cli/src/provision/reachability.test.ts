import type { NodeStatus } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import { probePortsFromStatus, renderEdgeProbeScript, renderTemporaryListenerScript } from "./reachability";

function statusWithPorts(): NodeStatus {
  return {
    nodeId: "byos-app-1",
    agentId: "agent-byos-app-1",
    lastSeen: "2026-06-20T00:00:00.000Z",
    agentVersion: "0.1.0",
    caddy: { managed: false, lastReloadAt: null, error: null },
    edgeRoutes: [],
    services: [
      {
        project: "p",
        service: "web",
        image: "repo/web:tag",
        state: "running",
        message: "",
        containerId: "c1",
        updatedAt: "2026-06-20T00:00:00.000Z",
        desiredReplicas: 3,
        runningReplicas: 2,
        replicas: [
          { index: 0, containerId: "c1", hostPort: 20003, state: "running", image: "repo/web:tag", healthy: true },
          { index: 1, containerId: "c2", hostPort: 20001, state: "running", image: "repo/web:tag", healthy: true },
          { index: 2, containerId: null, hostPort: 20002, state: "starting", image: "repo/web:tag", healthy: false },
        ],
      },
      {
        project: "p",
        service: "worker",
        image: "repo/worker:tag",
        state: "running",
        message: "",
        containerId: "w1",
        updatedAt: "2026-06-20T00:00:00.000Z",
        desiredReplicas: 1,
        runningReplicas: 1,
        replicas: [{ index: 0, containerId: "w1", hostPort: null, state: "running", image: "repo/worker:tag", healthy: false }],
      },
    ],
  };
}

describe("reachability probe helpers", () => {
  it("extracts sorted running web host ports from status", () => {
    expect(probePortsFromStatus(statusWithPorts())).toEqual([20001, 20003]);
  });

  it("renders an edge probe script for each advertised port", () => {
    const [script] = renderEdgeProbeScript([
      { nodeId: "byos-app-1", advertiseIp: "203.0.113.10", ports: [20000, 20001] },
    ]);

    expect(script).toContain("</dev/tcp/'203.0.113.10'/20000");
    expect(script).toContain("OK byos-app-1 203.0.113.10:20001");
    expect(script).toContain("FAIL byos-app-1 203.0.113.10:20001");
  });

  it("renders a one-shot temporary listener for node init", () => {
    const script = renderTemporaryListenerScript(20000);

    expect(script).toContain('s.bind(("0.0.0.0", 20000))');
    expect(script).toContain("s.settimeout(45)");
  });
});
