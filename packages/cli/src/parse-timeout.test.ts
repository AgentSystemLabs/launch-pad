import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { resolveTimeoutMs } from "./parse-timeout";

describe("resolveTimeoutMs", () => {
  it("returns the default in milliseconds when the flag is omitted", () => {
    expect(resolveTimeoutMs(undefined, 180)).toBe(180_000);
  });

  it("parses a positive integer string to milliseconds", () => {
    expect(resolveTimeoutMs("300", 180)).toBe(300_000);
  });

  it("rejects non-integer and sub-1 values", () => {
    for (const raw of ["abc", "0", "-5"]) {
      expect(() => resolveTimeoutMs(raw, 180, 300)).toThrow(CliError);
    }
  });
});
