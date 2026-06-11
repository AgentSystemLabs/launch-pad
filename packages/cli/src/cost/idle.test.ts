import { describe, expect, it } from "vitest";
import { type IdleNodeInput, recommendIdleNodes } from "./idle";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-10T00:00:00.000Z");

/** Build an idle input with sensible defaults (a fresh, busy, ready both-node). */
function node(over: Partial<IdleNodeInput> & Pick<IdleNodeInput, "nodeId">): IdleNodeInput {
  return {
    role: "both",
    instanceType: "t3.small",
    state: "ready",
    createdAt: new Date(NOW).toISOString(),
    lastSeen: new Date(NOW).toISOString(),
    desiredServices: 1,
    edgeRoutes: null,
    ...over,
  };
}

/** ISO string `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("recommendIdleNodes — paused nodes", () => {
  it("flags a stopped node idle past the threshold, dated from its last heartbeat", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "n1", state: "stopped", lastSeen: daysAgo(10), createdAt: daysAgo(30) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.nodeId).toBe("n1");
    expect(recs[0]!.kind).toBe("paused");
    expect(recs[0]!.idleDays).toBe(10);
    // Paused compute isn't billed, so EBS+EIP waste is not dollar-estimated.
    expect(recs[0]!.monthlyWasteUsd).toBeNull();
  });

  it("does not flag a stopped node still within the threshold", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "n1", state: "stopped", lastSeen: daysAgo(3) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(0);
  });

  it("falls back to createdAt when a stopped node has no heartbeat", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "n1", state: "stopped", lastSeen: null, createdAt: daysAgo(14) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.idleDays).toBe(14);
  });
});

describe("recommendIdleNodes — empty running nodes", () => {
  it("flags a ready app/both node with no scheduled services, dollar-estimating wasted EC2", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "n1", desiredServices: 0, createdAt: daysAgo(20) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("empty");
    expect(recs[0]!.idleDays).toBe(20);
    // A running empty node burns its full EC2 rate for nothing.
    expect(recs[0]!.monthlyWasteUsd).toBeGreaterThan(0);
  });

  it("does not flag a ready node that hosts services", () => {
    const recs = recommendIdleNodes([node({ nodeId: "n1", desiredServices: 2 })], NOW, {
      minIdleDays: 0,
    });
    expect(recs).toHaveLength(0);
  });

  it("does not flag a freshly-created empty node within the threshold", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "n1", desiredServices: 0, createdAt: daysAgo(2) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(0);
  });

  it("flags an edge node routing zero domains", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "e1", role: "edge", desiredServices: 0, edgeRoutes: 0, createdAt: daysAgo(20) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe("empty");
  });

  it("does not flag an edge node that is actively routing", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "e1", role: "edge", desiredServices: 0, edgeRoutes: 3, createdAt: daysAgo(20) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(0);
  });

  it("does not flag an edge node with unknown routing (no status yet)", () => {
    const recs = recommendIdleNodes(
      [node({ nodeId: "e1", role: "edge", desiredServices: 0, edgeRoutes: null, createdAt: daysAgo(20) })],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs).toHaveLength(0);
  });
});

describe("recommendIdleNodes — lifecycle states", () => {
  it("ignores provisioning, terminating, and terminated nodes", () => {
    const recs = recommendIdleNodes(
      [
        node({ nodeId: "p", state: "provisioning", desiredServices: 0, createdAt: daysAgo(20) }),
        node({ nodeId: "t1", state: "terminating", desiredServices: 0, createdAt: daysAgo(20) }),
        node({ nodeId: "t2", state: "terminated", desiredServices: 0, createdAt: daysAgo(20) }),
      ],
      NOW,
      { minIdleDays: 0 },
    );
    expect(recs).toHaveLength(0);
  });

  it("defaults minIdleDays to 7 when unspecified", () => {
    const within = recommendIdleNodes(
      [node({ nodeId: "n1", state: "stopped", lastSeen: daysAgo(5) })],
      NOW,
    );
    const past = recommendIdleNodes(
      [node({ nodeId: "n1", state: "stopped", lastSeen: daysAgo(8) })],
      NOW,
    );
    expect(within).toHaveLength(0);
    expect(past).toHaveLength(1);
  });

  it("sorts recommendations by most-idle first", () => {
    const recs = recommendIdleNodes(
      [
        node({ nodeId: "a", state: "stopped", lastSeen: daysAgo(8) }),
        node({ nodeId: "b", state: "stopped", lastSeen: daysAgo(30) }),
        node({ nodeId: "c", state: "stopped", lastSeen: daysAgo(15) }),
      ],
      NOW,
      { minIdleDays: 7 },
    );
    expect(recs.map((r) => r.nodeId)).toEqual(["b", "c", "a"]);
  });
});
