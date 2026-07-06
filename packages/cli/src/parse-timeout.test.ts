import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { parseTimeoutMs } from "./parse-timeout";

const HINT = "pass whole seconds ≥ 1, e.g. --timeout 180";

describe("parseTimeoutMs", () => {
  it("returns the default in milliseconds when the flag is omitted", () => {
    expect(parseTimeoutMs(undefined, 180, HINT)).toBe(180_000);
  });

  it("parses a positive integer to milliseconds", () => {
    expect(parseTimeoutMs("300", 180, HINT)).toBe(300_000);
  });

  it("rejects non-integer and sub-second values", () => {
    for (const raw of ["abc", "0", "-5"]) {
      expect(() => parseTimeoutMs(raw, 180, HINT)).toThrow(CliError);
    }
  });
});
