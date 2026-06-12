import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENT,
  findCrossComponentServiceConflicts,
  parseProjectIndex,
  removeComponentEntry,
  upsertComponentEntry,
} from "./project-registry";

const T1 = "2026-06-12T00:00:00.000Z";
const T2 = "2026-06-12T01:00:00.000Z";

describe("upsertComponentEntry", () => {
  it("creates a fresh index from null", () => {
    const idx = upsertComponentEntry(null, {
      project: "shop",
      component: "auth",
      services: ["auth"],
      now: T1,
    });
    expect(idx.project).toBe("shop");
    expect(idx.components).toEqual([
      { component: "auth", owner: "shop--auth", services: ["auth"], updatedAt: T1 },
    ]);
    // Round-trips through the strict schema.
    expect(parseProjectIndex(idx)).toEqual(idx);
  });

  it("records an omitted component as the default name with owner = project", () => {
    const idx = upsertComponentEntry(null, { project: "shop", component: undefined, services: ["web"], now: T1 });
    expect(idx.components[0]).toEqual({
      component: DEFAULT_COMPONENT,
      owner: "shop",
      services: ["web"],
      updatedAt: T1,
    });
  });

  it("upserts in place, keeps siblings, sorts components and services", () => {
    const a = upsertComponentEntry(null, { project: "shop", component: "notes", services: ["notes"], now: T1 });
    const b = upsertComponentEntry(a, { project: "shop", component: "auth", services: ["b-svc", "a-svc"], now: T1 });
    const c = upsertComponentEntry(b, { project: "shop", component: "auth", services: ["a-svc"], now: T2 });
    expect(c.components.map((x) => x.component)).toEqual(["auth", "notes"]);
    expect(c.components[0]?.services).toEqual(["a-svc"]);
    expect(c.components[0]?.updatedAt).toBe(T2);
    expect(c.components[1]?.updatedAt).toBe(T1);
    expect(c.updatedAt).toBe(T2);
  });

  it("dedupes service names", () => {
    const idx = upsertComponentEntry(null, { project: "shop", component: "auth", services: ["x", "x"], now: T1 });
    expect(idx.components[0]?.services).toEqual(["x"]);
  });
});

describe("removeComponentEntry", () => {
  const two = upsertComponentEntry(
    upsertComponentEntry(null, { project: "shop", component: "auth", services: ["auth"], now: T1 }),
    { project: "shop", component: "notes", services: ["notes"], now: T1 },
  );

  it("drops one component and stamps the index", () => {
    const next = removeComponentEntry(two, "auth", T2);
    expect(next?.components.map((c) => c.component)).toEqual(["notes"]);
    expect(next?.updatedAt).toBe(T2);
  });

  it("returns null when the last component is removed (caller deletes the file)", () => {
    const one = removeComponentEntry(two, "auth", T2);
    expect(removeComponentEntry(one!, "notes", T2)).toBeNull();
  });

  it("removing an unknown component is a no-op shape-wise", () => {
    const next = removeComponentEntry(two, "ghost", T2);
    expect(next?.components).toHaveLength(2);
  });

  it("undefined removes the default-component entry", () => {
    const idx = upsertComponentEntry(null, { project: "shop", component: undefined, services: ["web"], now: T1 });
    expect(removeComponentEntry(idx, undefined, T2)).toBeNull();
  });
});

describe("findCrossComponentServiceConflicts", () => {
  const idx = upsertComponentEntry(
    upsertComponentEntry(null, { project: "shop", component: "auth", services: ["auth"], now: T1 }),
    { project: "shop", component: "notes", services: ["notes", "worker"], now: T1 },
  );

  it("no index means no constraint", () => {
    expect(findCrossComponentServiceConflicts(null, "auth", ["anything"])).toEqual([]);
  });

  it("a component's own services never conflict with themselves", () => {
    expect(findCrossComponentServiceConflicts(idx, "auth", ["auth"])).toEqual([]);
  });

  it("flags a service name another component already claims", () => {
    expect(findCrossComponentServiceConflicts(idx, "auth", ["auth", "notes"])).toEqual([
      { service: "notes", component: "notes" },
    ]);
  });

  it("an omitted component conflicts against named components (migration guard)", () => {
    expect(findCrossComponentServiceConflicts(idx, undefined, ["worker"])).toEqual([
      { service: "worker", component: "notes" },
    ]);
  });
});
