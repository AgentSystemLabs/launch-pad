import { describe, expect, it } from "vitest";
import { planResizeEvacuation } from "./resize-evacuate";

const owner = "shop";
const clusterPlaced = new Set(["web", "worker"]);

describe("planResizeEvacuation", () => {
  it("refuses a paused node — nothing is running, and the rebalance-back would wait on a stopped agent", () => {
    const plan = planResizeEvacuation({
      nodeState: "stopped",
      services: [{ project: owner, service: "worker" }],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({ kind: "refuse-stopped" });
  });

  it("drains when the node hosts this project's cluster-placed services", () => {
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [
        { project: owner, service: "web" },
        { project: owner, service: "worker" },
      ],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({ kind: "drain", ridesDowntime: [] });
  });

  it("refuses when a drain would be blocked by this project's pinned service on the node", () => {
    // `rebalance --drain` hard-blocks when the project pins a service to the drained node
    // (pinned placement is config-locked), so surface that before touching anything.
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [
        { project: owner, service: "worker" },
        { project: owner, service: "pinned-db" }, // not in clusterPlacedNames → pinned
      ],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({
      kind: "refuse-pinned",
      pinned: [{ project: owner, service: "pinned-db" }],
    });
  });

  it("resize-only when the node hosts ONLY this project's pinned service (nothing movable, no drain attempted)", () => {
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [{ project: owner, service: "pinned-db" }],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({
      kind: "resize-only",
      ridesDowntime: [{ project: owner, service: "pinned-db" }],
    });
  });

  it("lists other projects' services as riding the downtime (only this project's footprint moves)", () => {
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [
        { project: owner, service: "web" },
        { project: "blog", service: "web" }, // same service name, different project → unmovable
      ],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({
      kind: "drain",
      ridesDowntime: [{ project: "blog", service: "web" }],
    });
  });

  it("resize-only when the node hosts nothing movable — evacuation would be a no-op", () => {
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [
        { project: "blog", service: "web" },
        { project: owner, service: "pinned-db" },
      ],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({
      kind: "resize-only",
      ridesDowntime: [
        { project: "blog", service: "web" },
        { project: owner, service: "pinned-db" },
      ],
    });
  });

  it("resize-only with no services at all (e.g. an edge node, or nothing deployed)", () => {
    const plan = planResizeEvacuation({
      nodeState: "ready",
      services: [],
      ownerProject: owner,
      clusterPlacedNames: clusterPlaced,
    });
    expect(plan).toEqual({ kind: "resize-only", ridesDowntime: [] });
  });
});
