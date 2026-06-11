import { describe, expect, it } from "vitest";
import { type ServicePlacement, diffPlacement } from "./rebalance-plan";

/** Terse helper: build a ServicePlacement from a service name + node→replicas pairs. */
function sp(service: string, byNode: Record<string, number>): ServicePlacement {
  return { service, byNode: new Map(Object.entries(byNode)) };
}

describe("diffPlacement", () => {
  it("reports no change when current and planned match", () => {
    const current = [sp("web", { "node-a": 1, "node-b": 1 })];
    const planned = [sp("web", { "node-a": 1, "node-b": 1 })];
    const diff = diffPlacement(current, planned);
    expect(diff.changed).toBe(false);
    expect(diff.changes).toEqual([]);
    expect(diff.vacatedNodes).toEqual([]);
  });

  it("is order-insensitive across nodes", () => {
    const current = [sp("web", { "node-b": 1, "node-a": 2 })];
    const planned = [sp("web", { "node-a": 2, "node-b": 1 })];
    expect(diffPlacement(current, planned).changed).toBe(false);
  });

  it("detects a replica moving from one node to another", () => {
    // 3 replicas on 2 nodes (2+1) → spread across 3 nodes (1+1+1) after adding node-c.
    const current = [sp("web", { "node-a": 2, "node-b": 1 })];
    const planned = [sp("web", { "node-a": 1, "node-b": 1, "node-c": 1 })];
    const diff = diffPlacement(current, planned);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([
      { service: "web", node: "node-a", from: 2, to: 1 },
      { service: "web", node: "node-c", from: 0, to: 1 },
    ]);
    expect(diff.vacatedNodes).toEqual([]);
  });

  it("marks a node vacated when the footprint fully leaves it", () => {
    // node-b is destroyed/drained → both replicas consolidate onto node-a.
    const current = [sp("web", { "node-a": 1, "node-b": 1 })];
    const planned = [sp("web", { "node-a": 2 })];
    const diff = diffPlacement(current, planned);
    expect(diff.changed).toBe(true);
    expect(diff.vacatedNodes).toEqual(["node-b"]);
    expect(diff.changes).toEqual([
      { service: "web", node: "node-a", from: 1, to: 2 },
      { service: "web", node: "node-b", from: 1, to: 0 },
    ]);
  });

  it("does NOT vacate a node that still hosts another of the footprint's services", () => {
    // web leaves node-b, but worker still runs there → node-b is not vacated.
    const current = [sp("web", { "node-b": 1 }), sp("worker", { "node-b": 1 })];
    const planned = [sp("web", { "node-a": 1 }), sp("worker", { "node-b": 1 })];
    const diff = diffPlacement(current, planned);
    expect(diff.vacatedNodes).toEqual([]);
    expect(diff.changes).toEqual([
      { service: "web", node: "node-a", from: 0, to: 1 },
      { service: "web", node: "node-b", from: 1, to: 0 },
    ]);
  });

  it("sorts vacated nodes and changes deterministically", () => {
    const current = [sp("web", { "node-z": 1, "node-y": 1, "node-x": 1 })];
    const planned = [sp("web", { "node-a": 3 })];
    const diff = diffPlacement(current, planned);
    expect(diff.vacatedNodes).toEqual(["node-x", "node-y", "node-z"]);
    // changes sorted by (service, node).
    expect(diff.changes.map((c) => c.node)).toEqual(["node-a", "node-x", "node-y", "node-z"]);
  });

  it("handles a brand-new service with no current placement", () => {
    const diff = diffPlacement([], [sp("web", { "node-a": 1 })]);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([{ service: "web", node: "node-a", from: 0, to: 1 }]);
    expect(diff.vacatedNodes).toEqual([]);
  });

  it("treats a service dropping to zero everywhere as a full vacate", () => {
    const diff = diffPlacement([sp("web", { "node-a": 2 })], []);
    expect(diff.changed).toBe(true);
    expect(diff.vacatedNodes).toEqual(["node-a"]);
    expect(diff.changes).toEqual([{ service: "web", node: "node-a", from: 2, to: 0 }]);
  });

  it("ignores zero-count entries in the input maps", () => {
    const current = [sp("web", { "node-a": 1, "node-b": 0 })];
    const planned = [sp("web", { "node-a": 1 })];
    expect(diffPlacement(current, planned).changed).toBe(false);
  });
});
