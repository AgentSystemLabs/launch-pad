import { describe, expect, it } from "vitest";
import { resolveDrainSet } from "./rebalance";

describe("resolveDrainSet", () => {
  it("is empty when neither drain nor drainNodes is given", () => {
    expect([...resolveDrainSet(undefined, undefined)]).toEqual([]);
  });

  it("includes the single --drain node", () => {
    expect([...resolveDrainSet("a", undefined)]).toEqual(["a"]);
  });

  it("includes every node in drainNodes", () => {
    expect([...resolveDrainSet(undefined, ["a", "b"])].sort()).toEqual(["a", "b"]);
  });

  it("unions drain + drainNodes and dedupes overlap", () => {
    expect([...resolveDrainSet("a", ["b", "a"])].sort()).toEqual(["a", "b"]);
  });
});
