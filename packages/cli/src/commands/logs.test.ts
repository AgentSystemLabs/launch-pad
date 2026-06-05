import { describe, expect, it } from "vitest";
import { CliError } from "../errors";
import { parseSince, unwrapDockerLogLine } from "./logs";

describe("parseSince", () => {
  it("parses the documented windows", () => {
    expect(parseSince("15m")).toBe(15 * 60_000);
    expect(parseSince("1h")).toBe(3_600_000);
    expect(parseSince("24h")).toBe(24 * 3_600_000);
    expect(parseSince("7d")).toBe(7 * 86_400_000);
    expect(parseSince("30s")).toBe(30_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseSince(" 5m ")).toBe(5 * 60_000);
  });

  it("rejects malformed windows with a hint", () => {
    expect(() => parseSince("5")).toThrow(CliError);
    expect(() => parseSince("abc")).toThrow(CliError);
    expect(() => parseSince("5w")).toThrow(CliError);
    expect(() => parseSince("")).toThrow(CliError);
  });
});

describe("unwrapDockerLogLine", () => {
  it("unwraps a docker json-file line to its log text", () => {
    expect(unwrapDockerLogLine('{"log":"hello world\\n","stream":"stdout","time":"2026-06-04T00:00:00Z"}')).toBe(
      "hello world",
    );
  });

  it("keeps a stderr line's content the same way", () => {
    expect(unwrapDockerLogLine('{"log":"boom","stream":"stderr","time":"t"}')).toBe("boom");
  });

  it("passes through a plain (non-json) line, trimming a trailing newline", () => {
    expect(unwrapDockerLogLine("just text\n")).toBe("just text");
    expect(unwrapDockerLogLine("agent started")).toBe("agent started");
  });

  it("leaves malformed json untouched (minus trailing newline)", () => {
    expect(unwrapDockerLogLine('{not valid json\n')).toBe("{not valid json");
  });

  it("preserves a json object that has no `log` field", () => {
    const raw = '{"level":"info","msg":"hi"}';
    expect(unwrapDockerLogLine(raw)).toBe(raw);
  });
});
