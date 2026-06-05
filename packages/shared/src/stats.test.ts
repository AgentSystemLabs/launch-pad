import { describe, expect, it } from "vitest";
import {
  buildStatsLine,
  hostMemoryPercent,
  parseStatsLine,
  serializeStatsLine,
  STATS_EVENT,
} from "./stats";

describe("buildStatsLine", () => {
  it("defaults services to an empty array", () => {
    const line = buildStatsLine({
      nodeId: "node-1",
      ts: "2026-06-04T00:00:00Z",
      host: { cpuPercent: 12.3, memoryUsedMb: 500, memoryTotalMb: 2000 },
    });
    expect(line.event).toBe(STATS_EVENT);
    expect(line.services).toEqual([]);
  });

  it("round-trips through serialize → parse", () => {
    const line = buildStatsLine({
      nodeId: "node-1",
      ts: "2026-06-04T00:00:00Z",
      host: { cpuPercent: 12.3, memoryUsedMb: 500, memoryTotalMb: 2000 },
      services: [
        {
          project: "blog",
          service: "api",
          replica: 0,
          cpuPercent: 40,
          memoryUsedMb: 100,
          memoryLimitMb: 256,
        },
      ],
    });
    const parsed = parseStatsLine(serializeStatsLine(line));
    expect(parsed).toEqual(line);
  });
});

describe("parseStatsLine", () => {
  it("returns null for a non-stats agent log line", () => {
    expect(parseStatsLine("[agent] s3: status PUT")).toBeNull();
  });

  it("returns null for malformed JSON that mentions the event", () => {
    expect(parseStatsLine('{"event":"launchpad.stats" oops')).toBeNull();
  });

  it("returns null when required host fields are missing", () => {
    expect(parseStatsLine('{"event":"launchpad.stats","nodeId":"n","ts":"t"}')).toBeNull();
  });

  it("ignores a different event entirely without parsing", () => {
    expect(parseStatsLine('{"event":"something.else","host":{}}')).toBeNull();
  });

  it("tolerates unknown future fields (forward-compatible)", () => {
    const raw = JSON.stringify({
      event: STATS_EVENT,
      nodeId: "node-1",
      ts: "2026-06-04T00:00:00Z",
      host: { cpuPercent: 1, memoryUsedMb: 1, memoryTotalMb: 2, futureField: 9 },
      services: [],
      anotherFuture: "x",
    });
    const parsed = parseStatsLine(raw);
    expect(parsed?.nodeId).toBe("node-1");
    expect((parsed?.host as Record<string, unknown>).futureField).toBeUndefined();
  });
});

describe("hostMemoryPercent", () => {
  it("computes used/total as a percentage", () => {
    expect(hostMemoryPercent({ cpuPercent: 0, memoryUsedMb: 500, memoryTotalMb: 2000 })).toBe(25);
  });

  it("is 0 when total is unknown", () => {
    expect(hostMemoryPercent({ cpuPercent: 0, memoryUsedMb: 500, memoryTotalMb: 0 })).toBe(0);
  });
});
