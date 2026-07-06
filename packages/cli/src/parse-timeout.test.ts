import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { resolveTimeoutMs } from "./parse-timeout";

describe("resolveTimeoutMs", () => {
  it("returns the default when the flag is omitted", () => {
    expect(resolveTimeoutMs(undefined, 180)).toBe(180_000);
  });

  it("parses whole seconds", () => {
    expect(resolveTimeoutMs("300", 180)).toBe(300_000);
  });

  it("rejects invalid values", () => {
    for (const bad of ["abc", "0", "-1"]) {
      expect(() => resolveTimeoutMs(bad, 180, 120)).toThrow(CliError);
    }
  });
});
