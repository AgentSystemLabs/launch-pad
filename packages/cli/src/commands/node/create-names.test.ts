import { describe, expect, it } from "vitest";
import { parseCreateAmount, planNodeCreateNames } from "./create-names";

describe("planNodeCreateNames", () => {
  it("returns the exact name when amount is 1", () => {
    expect(planNodeCreateNames("solo", 1)).toEqual(["solo"]);
    expect(planNodeCreateNames("app-7", 1)).toEqual(["app-7"]);
  });

  it("suffixes a plain base name starting at 1", () => {
    expect(planNodeCreateNames("app", 3)).toEqual(["app-1", "app-2", "app-3"]);
  });

  it("continues from a numeric suffix on the base name", () => {
    expect(planNodeCreateNames("app-2", 3)).toEqual(["app-2", "app-3", "app-4"]);
  });

  it("does not treat a non-terminal number as a suffix", () => {
    expect(planNodeCreateNames("node-v2", 2)).toEqual(["node-v2-1", "node-v2-2"]);
  });

  it("rejects invalid amounts", () => {
    expect(() => planNodeCreateNames("app", 0)).toThrow(/invalid --amount/);
    expect(() => planNodeCreateNames("app", -1)).toThrow(/invalid --amount/);
  });
});

describe("parseCreateAmount", () => {
  it("defaults to 1", () => {
    expect(parseCreateAmount(undefined)).toBe(1);
    expect(parseCreateAmount("")).toBe(1);
  });

  it("parses positive integers", () => {
    expect(parseCreateAmount("3")).toBe(3);
    expect(parseCreateAmount(5)).toBe(5);
  });

  it("rejects invalid values", () => {
    expect(() => parseCreateAmount("0")).toThrow(/invalid --amount/);
    expect(() => parseCreateAmount("abc")).toThrow(/invalid --amount/);
  });
});
