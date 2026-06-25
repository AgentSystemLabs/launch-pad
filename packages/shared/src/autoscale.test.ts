import { describe, expect, it } from "vitest";
import {
  type AutoscaleNodeObservation,
  parseAutoscalePolicy,
  planAutoscale,
  scaleOutNodeSpec,
} from "./autoscale";

const NOW = Date.parse("2026-06-11T12:00:00Z");

function node(overrides: Partial<AutoscaleNodeObservation> & { nodeId: string }): AutoscaleNodeObservation {
  return {
    role: "app",
    state: "ready",
    protected: false,
    cpuPercent: 10,
    memoryPercent: 20,
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return parseAutoscalePolicy({ minNodes: 1, maxNodes: 3, ...overrides });
}

describe("parseAutoscalePolicy", () => {
  it("applies defaults for thresholds, cooldown and lastScaleAt", () => {
    const p = parseAutoscalePolicy({ minNodes: 1, maxNodes: 2 });
    expect(p.scaleOutPercent).toBe(80);
    expect(p.scaleInPercent).toBe(30);
    expect(p.cooldownSeconds).toBe(300);
    expect(p.lastScaleAt).toBeNull();
  });

  it("rejects maxNodes below minNodes", () => {
    expect(() => parseAutoscalePolicy({ minNodes: 3, maxNodes: 2 })).toThrow();
  });

  it("rejects a scale-in threshold at or above the scale-out threshold (thrash guard)", () => {
    expect(() => parseAutoscalePolicy({ minNodes: 1, maxNodes: 2, scaleOutPercent: 50, scaleInPercent: 50 })).toThrow();
    expect(() => parseAutoscalePolicy({ minNodes: 1, maxNodes: 2, scaleOutPercent: 50, scaleInPercent: 60 })).toThrow();
  });

  it("rejects unknown keys and a zero minNodes", () => {
    expect(() => parseAutoscalePolicy({ minNodes: 0, maxNodes: 2 })).toThrow();
    expect(() => parseAutoscalePolicy({ minNodes: 1, maxNodes: 2, extra: true })).toThrow();
  });

  it("rejects node counts above the 100-node spend-typo ceiling", () => {
    expect(() => parseAutoscalePolicy({ minNodes: 1, maxNodes: 101 })).toThrow();
    expect(() => parseAutoscalePolicy({ minNodes: 101, maxNodes: 101 })).toThrow();
    expect(parseAutoscalePolicy({ minNodes: 1, maxNodes: 100 }).maxNodes).toBe(100);
  });
});

describe("planAutoscale — pool membership", () => {
  it("counts only up app nodes toward the pool (edge + stopped excluded)", () => {
    // 1 ready app node + 1 edge + 1 stopped app ⇒ pool size 1 = minNodes ⇒ no floor action.
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3 }),
      nodes: [
        node({ nodeId: "app-1" }),
        node({ nodeId: "edge-1", role: "edge" }),
        node({ nodeId: "app-2", state: "stopped" }),
      ],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });

  it("a still-provisioning node counts toward the pool (no double scale-out while it boots)", () => {
    // app-2 was just added (registry state "provisioning", agent not up yet → no metrics).
    // The pool is at maxNodes, so a hot app-1 must NOT trigger another scale-out.
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 2, cooldownSeconds: 0 }),
      nodes: [
        node({ nodeId: "app-1", cpuPercent: 99, memoryPercent: 99 }),
        node({ nodeId: "app-2", state: "provisioning", cpuPercent: null, memoryPercent: null }),
      ],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("max");
  });

  it("a provisioning node without metrics also blocks scale-in (conservative)", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30, cooldownSeconds: 0 }),
      nodes: [
        node({ nodeId: "app-1", cpuPercent: 1, memoryPercent: 1 }),
        node({ nodeId: "app-2", state: "provisioning", cpuPercent: null, memoryPercent: null }),
      ],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });
});

describe("planAutoscale — maintain minNodes", () => {
  it("scales out when the pool is below minNodes", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 2, maxNodes: 3 }),
      nodes: [node({ nodeId: "app-1" })],
      nowMs: NOW,
    });
    expect(d.action).toBe("scale-out");
  });

  it("the minNodes floor bypasses the cooldown", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 2, maxNodes: 3, cooldownSeconds: 3600, lastScaleAt: new Date(NOW - 1000).toISOString() }),
      nodes: [node({ nodeId: "app-1" })],
      nowMs: NOW,
    });
    expect(d.action).toBe("scale-out");
  });
});

describe("planAutoscale — cooldown", () => {
  it("does nothing while a utilization action is cooling down", () => {
    const d = planAutoscale({
      policy: policy({ cooldownSeconds: 300, lastScaleAt: new Date(NOW - 60_000).toISOString() }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 99, memoryPercent: 99 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("cooldown");
  });

  it("acts again once the cooldown has elapsed", () => {
    const d = planAutoscale({
      policy: policy({ cooldownSeconds: 300, lastScaleAt: new Date(NOW - 301_000).toISOString() }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 99, memoryPercent: 99 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("scale-out");
  });
});

describe("planAutoscale — utilization scale-out", () => {
  it("scales out when average CPU is at/above the threshold", () => {
    const d = planAutoscale({
      policy: policy({ scaleOutPercent: 80 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 90, memoryPercent: 10 }), node({ nodeId: "app-2", cpuPercent: 70, memoryPercent: 10 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("scale-out"); // avg cpu = 80
  });

  it("scales out on memory pressure alone", () => {
    const d = planAutoscale({
      policy: policy({ scaleOutPercent: 80 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 5, memoryPercent: 95 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("scale-out");
  });

  it("never scales out past maxNodes", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 2, scaleOutPercent: 50 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 99 }), node({ nodeId: "app-2", cpuPercent: 99 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("max");
  });

  it("does nothing when no node has fresh metrics", () => {
    const d = planAutoscale({
      policy: policy({ scaleOutPercent: 10, scaleInPercent: 5 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: null, memoryPercent: null })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
    expect(d.reason).toContain("metric");
  });
});

describe("planAutoscale — utilization scale-in", () => {
  it("scales in when every node is below the scale-in threshold, picking the least-utilized victim", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({ nodeId: "app-1", cpuPercent: 25, memoryPercent: 20 }),
        node({ nodeId: "app-2", cpuPercent: 5, memoryPercent: 10 }),
      ],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });

  it("breaks utilization ties by preferring the higher node id (most recently added)", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 5, memoryPercent: 5 }), node({ nodeId: "app-2", cpuPercent: 5, memoryPercent: 5 })],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });

  it("never scales in below minNodes", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 1, memoryPercent: 1 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });

  it("refuses to scale in when ANY pool node is missing metrics (conservative)", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 1, memoryPercent: 1 }), node({ nodeId: "app-2", cpuPercent: null, memoryPercent: null })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });

  it("does not scale in when one node is above the threshold", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 50, memoryPercent: 10 }), node({ nodeId: "app-2", cpuPercent: 1, memoryPercent: 1 })],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });

  it("never picks a protected node as the victim", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({ nodeId: "app-1", protected: true, cpuPercent: 1, memoryPercent: 1 }),
        node({ nodeId: "app-2", cpuPercent: 20, memoryPercent: 20 }),
      ],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });

  it("does nothing when every scale-in candidate is protected", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({ nodeId: "app-1", protected: true, cpuPercent: 1, memoryPercent: 1 }),
        node({ nodeId: "app-2", protected: true, cpuPercent: 1, memoryPercent: 1 }),
      ],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });
});

describe("planAutoscale — external (BYOS) nodes are never scale-in victims", () => {
  // External nodes are real capacity (count toward pool size / minNodes / utilization)
  // but the autoscaler doesn't own the operator's host, so it must never drain one.
  it("never picks an external node as the victim — drains the EC2 node instead", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        // External node is the coldest (would be the natural victim) but is off-limits.
        node({ nodeId: "byos-1", provisioning: "external", cpuPercent: 1, memoryPercent: 1 }),
        node({ nodeId: "app-1", provisioning: "ec2", cpuPercent: 20, memoryPercent: 20 }),
      ],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-1" });
  });

  it("does nothing when the external node is the only non-protected candidate", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({ nodeId: "app-1", protected: true, cpuPercent: 1, memoryPercent: 1 }),
        node({ nodeId: "byos-1", provisioning: "external", cpuPercent: 1, memoryPercent: 1 }),
      ],
      nowMs: NOW,
    });
    expect(d.action).toBe("none");
  });

  it("counts an external node toward pool size so the cold EC2 node stays above minNodes", () => {
    // Pool size 2 (external + ec2) > minNodes 1, both cold, ec2 is the only drainable
    // candidate ⇒ the ec2 node IS drained (external keeps the pool from falling under min).
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({ nodeId: "byos-1", provisioning: "external", cpuPercent: 5, memoryPercent: 5 }),
        node({ nodeId: "app-1", provisioning: "ec2", cpuPercent: 5, memoryPercent: 5 }),
      ],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-1" });
  });
});


describe("planAutoscale — scale-in reservation feasibility", () => {
  // The e2e found this live: utilization said "scale in" but the survivors couldn't
  // absorb the victim's RESERVED footprint, so the drain died on the capacity
  // admission check (publishDesired's assertCapacity). The planner must refuse
  // (or pick another victim) instead of proposing an infeasible drain.
  const reservedIdle = { steadyCpu: 0, steadyMemory: 0, surgeCpu: 0, surgeMemory: 0, allocatableCpu: 1792, allocatableMemory: 3584 };

  it("refuses scale-in when the survivors cannot absorb the victim's reservations", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({
          nodeId: "app-1",
          cpuPercent: 5,
          memoryPercent: 10,
          reserved: { ...reservedIdle, steadyMemory: 1536, surgeMemory: 1536 },
        }),
        node({
          nodeId: "app-2",
          cpuPercent: 2,
          memoryPercent: 8,
          reserved: { ...reservedIdle, steadyMemory: 1536, surgeMemory: 1536 },
        }),
      ],
      nowMs: NOW,
    });
    // Survivor app-1: 1536 (own) + 1536 (victim's) + 1536 surge = 4608 > 3584 allocatable.
    expect(d.action).toBe("none");
    expect(d.reason).toContain("absorb");
  });

  it("allows scale-in when the survivors can absorb the victim's reservations", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [
        node({
          nodeId: "app-1",
          cpuPercent: 5,
          memoryPercent: 10,
          reserved: { ...reservedIdle, steadyMemory: 1024, surgeMemory: 1024 },
        }),
        node({
          nodeId: "app-2",
          cpuPercent: 2,
          memoryPercent: 8,
          reserved: { ...reservedIdle, steadyMemory: 1024, surgeMemory: 1024 },
        }),
      ],
      nowMs: NOW,
    });
    // Survivor app-1: 1024 + 1024 + 1024 surge = 3072 ≤ 3584 — feasible.
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });

  it("skips an infeasible least-utilized victim and picks a feasible one", () => {
    // app-3 is the coldest but it's the BIG node — removing it leaves too little total
    // allocatable for the pool's reservations. Removing the small app-2 is fine, so the
    // planner drains app-2 instead of refusing outright.
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 4, scaleInPercent: 30 }),
      nodes: [
        node({
          nodeId: "app-1",
          cpuPercent: 20,
          memoryPercent: 20,
          reserved: { ...reservedIdle, steadyMemory: 3000, surgeMemory: 200, allocatableMemory: 3584 },
        }),
        node({
          nodeId: "app-2",
          cpuPercent: 10,
          memoryPercent: 10,
          reserved: { ...reservedIdle, steadyMemory: 1000, surgeMemory: 200, allocatableMemory: 1536 },
        }),
        node({
          nodeId: "app-3",
          cpuPercent: 1,
          memoryPercent: 1,
          reserved: { ...reservedIdle, steadyMemory: 5000, surgeMemory: 200, allocatableMemory: 8192 },
        }),
      ],
      nowMs: NOW,
    });
    // Victim app-3: survivors hold 3584+1536 = 5120 < 9000 steady + 200 surge — infeasible.
    // Victim app-2: survivors hold 3584+8192 = 11776 ≥ 9200 — feasible.
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });

  it("falls back to utilization-only behavior when reservations are not provided", () => {
    const d = planAutoscale({
      policy: policy({ minNodes: 1, maxNodes: 3, scaleInPercent: 30 }),
      nodes: [node({ nodeId: "app-1", cpuPercent: 5, memoryPercent: 5 }), node({ nodeId: "app-2", cpuPercent: 1, memoryPercent: 1 })],
      nowMs: NOW,
    });
    expect(d).toMatchObject({ action: "scale-in", victim: "app-2" });
  });
});

describe("scaleOutNodeSpec", () => {
  it("generates a unique <noun>-<verb>-<adverb> id avoiding existing nodes", () => {
    const existing = ["app-1", "app-3", "edge-1"];
    const spec = scaleOutNodeSpec({
      existingNodeIds: existing,
      pool: [{ nodeId: "app-1", instanceType: "t3.small" }],
      defaultEdge: "edge-1",
    });
    expect(spec.nodeId).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(existing).not.toContain(spec.nodeId);
  });

  it("honors an injected rng for a deterministic id", () => {
    const a = scaleOutNodeSpec({ existingNodeIds: [], pool: [], defaultEdge: "edge-1", rng: () => 0 });
    const b = scaleOutNodeSpec({ existingNodeIds: [], pool: [], defaultEdge: "edge-1", rng: () => 0 });
    expect(a.nodeId).toBe(b.nodeId);
  });

  it("matches the largest existing pool instance type", () => {
    const spec = scaleOutNodeSpec({
      existingNodeIds: ["app-1", "app-2"],
      pool: [
        { nodeId: "app-1", instanceType: "t3.small" },
        { nodeId: "app-2", instanceType: "t3.medium" },
      ],
      defaultEdge: "edge-1",
    });
    expect(spec.instanceType).toBe("t3.medium");
  });

  it("falls back to t3.small for an empty/unknown pool", () => {
    const spec = scaleOutNodeSpec({ existingNodeIds: [], pool: [], defaultEdge: "edge-1" });
    expect(spec.instanceType).toBe("t3.small");
  });

  it("always creates an app node behind the cluster's dedicated edge", () => {
    const spec = scaleOutNodeSpec({
      existingNodeIds: ["edge-1", "app-1"],
      pool: [{ nodeId: "app-1", instanceType: "t3.small" }],
      defaultEdge: "edge-1",
    });
    expect(spec.role).toBe("app");
    expect(spec.edgeNodeId).toBe("edge-1");
  });
});
