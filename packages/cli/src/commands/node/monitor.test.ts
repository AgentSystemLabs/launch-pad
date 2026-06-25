import { describe, expect, it } from "vitest";
import {
  serializeStatsLine,
  type NodeStatus,
  type StatsLine,
} from "@agentsystemlabs/launch-pad-shared";
import type { LogEvent } from "../../aws/cloudwatch-logs";
import {
  matchingServices,
  sampleFromNodeStatus,
  samplesFromLogEvents,
  serviceSeries,
  summarize,
} from "./monitor";

function statsLine(over: Partial<StatsLine> & { ts: string }): StatsLine {
  return {
    event: "launchpad.stats",
    nodeId: "node-1",
    host: { cpuPercent: 10, memoryUsedMb: 500, memoryTotalMb: 2000 },
    services: [],
    ...over,
  };
}

function event(message: string, timestamp: number): LogEvent {
  return { message, timestamp, logStreamName: "agent", eventId: `${timestamp}` };
}

describe("samplesFromLogEvents", () => {
  it("parses stats lines, drops noise, and sorts by sample time", () => {
    const a = statsLine({ ts: "2026-06-04T00:00:02Z" });
    const b = statsLine({ ts: "2026-06-04T00:00:01Z" });
    const events = [
      event("[agent] s3: status PUT", 1000),
      event(serializeStatsLine(a), 2000),
      event("plain stderr noise", 1500),
      event(serializeStatsLine(b), 3000),
    ];
    const samples = samplesFromLogEvents(events);
    expect(samples).toHaveLength(2);
    // Sorted by the line's own ts (b is earlier), not by CloudWatch ingest time.
    expect(samples[0]?.ts).toBe("2026-06-04T00:00:01Z");
    expect(samples[1]?.ts).toBe("2026-06-04T00:00:02Z");
  });

  it("falls back to the log timestamp when ts is unparseable", () => {
    const line = serializeStatsLine(statsLine({ ts: "not-a-date" }));
    const samples = samplesFromLogEvents([event(line, 4242)]);
    expect(samples[0]?.epochMillis).toBe(4242);
  });
});

describe("matchingServices", () => {
  const sample = statsLine({
    ts: "t",
    services: [
      { project: "blog", service: "api", replica: 0, cpuPercent: 1, memoryUsedMb: 1, memoryLimitMb: 2 },
      { project: "blog", service: "worker", replica: 0, cpuPercent: 1, memoryUsedMb: 1, memoryLimitMb: 2 },
      { project: "shop", service: "api", replica: 0, cpuPercent: 1, memoryUsedMb: 1, memoryLimitMb: 2 },
    ],
  });

  it("returns all rows without a filter", () => {
    expect(matchingServices(sample)).toHaveLength(3);
  });

  it("filters by project AND service (not service name alone)", () => {
    const rows = matchingServices(sample, { project: "blog", service: "api" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project).toBe("blog");
  });
});

describe("summarize", () => {
  it("reports now/avg/max/min", () => {
    expect(summarize([10, 20, 30])).toEqual({ now: 30, avg: 20, max: 30, min: 10 });
  });
  it("is all-zero for an empty series", () => {
    expect(summarize([])).toEqual({ now: 0, avg: 0, max: 0, min: 0 });
  });
});

describe("serviceSeries", () => {
  it("sums a service's replicas per sample and collects replica indices", () => {
    const mk = (ts: string, cpu0: number, cpu1: number): StatsLine =>
      statsLine({
        ts,
        services: [
          { project: "blog", service: "api", replica: 0, cpuPercent: cpu0, memoryUsedMb: 100, memoryLimitMb: 256 },
          { project: "blog", service: "api", replica: 1, cpuPercent: cpu1, memoryUsedMb: 150, memoryLimitMb: 256 },
        ],
      });
    const samples = samplesFromLogEvents([
      event(serializeStatsLine(mk("2026-06-04T00:00:01Z", 10, 20)), 1000),
      event(serializeStatsLine(mk("2026-06-04T00:00:02Z", 30, 40)), 2000),
    ]);
    const series = serviceSeries(samples, { project: "blog", service: "api" });
    expect(series.cpu).toEqual([30, 70]);
    expect(series.memUsed).toEqual([250, 250]);
    expect(series.replicas).toEqual([0, 1]);
  });
});

describe("sampleFromNodeStatus", () => {
  it("maps the heartbeat host sample to a monitor stats sample", () => {
    const status: NodeStatus = {
      nodeId: "byos-app-1",
      agentId: "agent-byos-app-1",
      lastSeen: "2026-06-20T00:00:02.000Z",
      agentVersion: "0.1.0",
      caddy: { managed: false, lastReloadAt: null, error: null },
      edgeRoutes: [],
      host: {
        cpuPercent: 42,
        memoryUsedMb: 768,
        memoryTotalMb: 2048,
        sampledAt: "2026-06-20T00:00:01.000Z",
      },
      services: [
        {
          project: "blog",
          service: "web",
          image: "repo/web:tag",
          state: "running",
          message: "",
          containerId: "c1",
          replicas: [],
          desiredReplicas: 1,
          runningReplicas: 1,
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    };

    expect(sampleFromNodeStatus(status)).toEqual({
      event: "launchpad.stats",
      nodeId: "byos-app-1",
      ts: "2026-06-20T00:00:01.000Z",
      host: { cpuPercent: 42, memoryUsedMb: 768, memoryTotalMb: 2048 },
      services: [],
      epochMillis: Date.parse("2026-06-20T00:00:01.000Z"),
    });
  });

  it("returns null when the heartbeat has no host sample yet", () => {
    const status: NodeStatus = {
      nodeId: "byos-app-1",
      agentId: "agent-byos-app-1",
      lastSeen: "2026-06-20T00:00:02.000Z",
      agentVersion: "0.1.0",
      caddy: { managed: false, lastReloadAt: null, error: null },
      edgeRoutes: [],
      services: [],
    };

    expect(sampleFromNodeStatus(status)).toBeNull();
  });
});
