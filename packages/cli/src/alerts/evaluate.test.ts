import { describe, expect, it } from "vitest";
import type { NodeState, NodeStatus, ServiceStatus } from "@agentsystemlabs/launch-pad-shared";
import { type AlertNodeInput, evaluateAlerts } from "./evaluate";

const NOW = Date.parse("2026-06-11T00:00:00.000Z");

function status(over: Partial<NodeStatus> = {}): NodeStatus {
  return {
    nodeId: "n1",
    agentId: "agent-n1",
    lastSeen: new Date(NOW).toISOString(),
    agentVersion: "0.0.0",
    services: [],
    caddy: { managed: true, lastReloadAt: null, error: null },
    edgeRoutes: [],
    ...over,
  };
}

function svc(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    project: "blog",
    service: "api",
    image: "ecr/blog/api:abc",
    state: "running",
    message: "",
    containerId: "c1",
    replicas: [],
    desiredReplicas: 1,
    runningReplicas: 1,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** ISO `sec` seconds before NOW. */
function secAgo(sec: number): string {
  return new Date(NOW - sec * 1000).toISOString();
}

function node(state: NodeState, s: NodeStatus | null, id = "n1", createdAt = secAgo(3600)): AlertNodeInput {
  return { nodeId: id, state, status: s, createdAt };
}

describe("evaluateAlerts — heartbeat", () => {
  it("no alerts for a healthy ready node with a fresh heartbeat", () => {
    expect(evaluateAlerts([node("ready", status())], NOW)).toEqual([]);
  });

  it("alerts when a ready node's heartbeat is stale", () => {
    const alerts = evaluateAlerts([node("ready", status({ lastSeen: secAgo(300) }))], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("heartbeat-stale");
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.nodeId).toBe("n1");
  });

  it("alerts when a node has never reported status and is past the boot grace", () => {
    const alerts = evaluateAlerts([node("ready", null, "n1", secAgo(3600))], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("heartbeat-stale");
  });

  it("gives a still-booting node (no status, within boot grace) time before alerting", () => {
    // created 1 minute ago, no status yet — still coming up
    expect(evaluateAlerts([node("provisioning", null, "n1", secAgo(60))], NOW)).toEqual([]);
  });

  it("treats a `provisioning` node as live (a fresh node sits there until a drift repair)", () => {
    // provisioning + fresh heartbeat → healthy; + stale heartbeat → alert
    expect(evaluateAlerts([node("provisioning", status())], NOW)).toEqual([]);
    expect(evaluateAlerts([node("provisioning", status({ lastSeen: secAgo(300) }))], NOW)).toHaveLength(1);
  });

  it("does NOT alert on a paused/stopped node (its agent is intentionally off)", () => {
    expect(evaluateAlerts([node("stopped", null)], NOW)).toEqual([]);
    expect(evaluateAlerts([node("stopped", status({ lastSeen: secAgo(9999) }))], NOW)).toEqual([]);
  });

  it("does NOT alert on a terminating / terminated node", () => {
    expect(evaluateAlerts([node("terminating", null)], NOW)).toEqual([]);
    expect(evaluateAlerts([node("terminated", null)], NOW)).toEqual([]);
  });

  it("honors a custom staleMs threshold", () => {
    const n = [node("ready", status({ lastSeen: secAgo(30) }))];
    expect(evaluateAlerts(n, NOW, { staleMs: 60_000 })).toEqual([]); // 30s < 60s
    expect(evaluateAlerts(n, NOW, { staleMs: 10_000 })).toHaveLength(1); // 30s > 10s
  });
});

describe("evaluateAlerts — services", () => {
  it("alerts when a service is in the error state", () => {
    const alerts = evaluateAlerts(
      [node("ready", status({ services: [svc({ state: "error", message: "OOMKilled" })] }))],
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("service-unhealthy");
    expect(alerts[0]!.service).toBe("blog/api");
    expect(alerts[0]!.message).toMatch(/OOMKilled/);
  });

  it("alerts when a service has zero running replicas but wants some", () => {
    const alerts = evaluateAlerts(
      [node("ready", status({ services: [svc({ state: "pending", desiredReplicas: 2, runningReplicas: 0 })] }))],
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("service-unhealthy");
    expect(alerts[0]!.message).toMatch(/0\/2/);
  });

  it("does NOT alert on a partially-degraded service (likely a transient roll)", () => {
    const alerts = evaluateAlerts(
      [node("ready", status({ services: [svc({ state: "running", desiredReplicas: 3, runningReplicas: 2 })] }))],
      NOW,
    );
    expect(alerts).toEqual([]);
  });

  it("does NOT inspect services when the heartbeat is already stale (state is unreliable)", () => {
    const alerts = evaluateAlerts(
      [node("ready", status({ lastSeen: secAgo(300), services: [svc({ state: "error" })] }))],
      NOW,
    );
    // only the heartbeat-stale alert, not a duplicate service alert
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("heartbeat-stale");
  });
});

describe("evaluateAlerts — ordering + multiple", () => {
  it("sorts critical first, then by node id, and reports across nodes", () => {
    const alerts = evaluateAlerts(
      [
        node("ready", status({ services: [svc({ state: "error" })] }), "b-node"),
        node("ready", null, "a-node"),
        node("ready", status(), "c-node"), // healthy
      ],
      NOW,
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.nodeId)).toEqual(["a-node", "b-node"]);
  });
});
