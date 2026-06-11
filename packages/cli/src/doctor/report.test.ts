import { describe, expect, it } from "vitest";
import { type Check, overallOk, summarize } from "./report";

const check = (status: Check["status"]): Check => ({ name: "x", status, detail: "" });

describe("overallOk", () => {
  it("is true when every check passes", () => {
    expect(overallOk([check("pass"), check("pass")])).toBe(true);
  });

  it("is true when there are warnings or skips but no failures", () => {
    expect(overallOk([check("pass"), check("warn"), check("skip")])).toBe(true);
  });

  it("is false when any check fails", () => {
    expect(overallOk([check("pass"), check("fail"), check("warn")])).toBe(false);
  });

  it("is true for an empty list", () => {
    expect(overallOk([])).toBe(true);
  });
});

describe("summarize", () => {
  it("counts checks by status", () => {
    expect(
      summarize([check("pass"), check("pass"), check("warn"), check("fail"), check("skip")]),
    ).toEqual({ pass: 2, warn: 1, fail: 1, skip: 1 });
  });

  it("zeroes every bucket for an empty list", () => {
    expect(summarize([])).toEqual({ pass: 0, warn: 0, fail: 0, skip: 0 });
  });
});
