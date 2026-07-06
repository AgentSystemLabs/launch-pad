import { describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { parseTimeoutSeconds } from "./parse-timeout.js";

describe("parseTimeoutSeconds", () => {
  it("returns the default in milliseconds when the flag is omitted", () => {
    expect(parseTimeoutSeconds(undefined, 180)).toBe(180_000);
  });

  it("parses a positive integer string to milliseconds", () => {
    expect(parseTimeoutSeconds("300", 180)).toBe(300_000);
  });

  it.each(["abc", "0", "-5"])("rejects invalid timeout %s", (raw) => {
    expect(() => parseTimeoutSeconds(raw, 180)).toThrow(CliError);
  });
});
