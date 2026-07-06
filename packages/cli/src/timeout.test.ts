import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { resolveTimeoutSecondsMs } from "./timeout";

describe("resolveTimeoutSecondsMs", () => {
  it("returns the default in milliseconds when unset", () => {
    expect(resolveTimeoutSecondsMs(undefined, 180)).toBe(180_000);
  });

  it("parses whole seconds", () => {
    expect(resolveTimeoutSecondsMs("300", 180)).toBe(300_000);
  });

  it("rejects malformed values with a hint", () => {
    expect(() => resolveTimeoutSecondsMs("abc", 120, 120)).toThrow(CliError);
    expect(() => resolveTimeoutSecondsMs("0", 120, 120)).toThrow(CliError);
    expect(() => resolveTimeoutSecondsMs("-5", 120, 120)).toThrow(CliError);
  });
});
