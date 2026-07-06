import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { parseTimeoutSeconds, resolveTimeoutMs } from "./parse-timeout";

describe("parseTimeoutSeconds", () => {
  it("returns the default when omitted", () => {
    expect(parseTimeoutSeconds(undefined, { defaultSeconds: 180 })).toBe(180);
  });

  it("parses a positive integer", () => {
    expect(parseTimeoutSeconds("300", { defaultSeconds: 180 })).toBe(300);
  });

  it("rejects non-integers and values below 1", () => {
    expect(() => parseTimeoutSeconds("abc", { defaultSeconds: 180 })).toThrow(CliError);
    expect(() => parseTimeoutSeconds("0", { defaultSeconds: 180 })).toThrow(CliError);
    expect(() => parseTimeoutSeconds("-5", { defaultSeconds: 180 })).toThrow(CliError);
  });

  it("uses exampleSeconds in the hint when provided", () => {
    try {
      parseTimeoutSeconds("nope", { defaultSeconds: 180, exampleSeconds: 120 });
      expect.fail("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).hint).toContain("--timeout 120");
    }
  });
});

describe("resolveTimeoutMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(resolveTimeoutMs("60", { defaultSeconds: 180 })).toBe(60_000);
    expect(resolveTimeoutMs(undefined, { defaultSeconds: 180 })).toBe(180_000);
  });
});
