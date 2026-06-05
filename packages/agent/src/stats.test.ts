import { describe, expect, it } from "vitest";
import type { ManagedReplica } from "./docker";
import {
  assembleServiceStats,
  cpuPercentFromDelta,
  cpuPercentOfLimit,
  cpuSharesByKey,
  createStatsSampler,
  type DockerStatRow,
  parseCpuStat,
  parseDockerStats,
  parseMemInfo,
  parseMemUsage,
  parsePercent,
  parseSizeToMb,
} from "./stats";

describe("parseCpuStat", () => {
  it("sums all jiffy fields and takes idle+iowait", () => {
    // user nice system idle iowait irq softirq steal
    const stat = parseCpuStat("cpu  100 0 50 800 30 0 20 0\ncpu0 ...");
    expect(stat).toEqual({ total: 100 + 0 + 50 + 800 + 30 + 0 + 20 + 0, idle: 800 + 30 });
  });

  it("returns null without an aggregate cpu line", () => {
    expect(parseCpuStat("intr 1 2 3\nctxt 99")).toBeNull();
  });
});

describe("cpuPercentFromDelta", () => {
  it("computes busy fraction over the interval", () => {
    // 1000 total jiffies elapsed, 750 idle → 25% busy
    expect(
      cpuPercentFromDelta({ total: 0, idle: 0 }, { total: 1000, idle: 750 }),
    ).toBe(25);
  });

  it("is 0 when no time elapsed", () => {
    expect(cpuPercentFromDelta({ total: 10, idle: 5 }, { total: 10, idle: 5 })).toBe(0);
  });
});

describe("parseMemInfo", () => {
  it("derives used = total − available in MB", () => {
    const info = parseMemInfo("MemTotal:       2048000 kB\nMemFree: 100 kB\nMemAvailable:   1024000 kB\n");
    expect(info).toEqual({ memoryUsedMb: 1000, memoryTotalMb: 2000 });
  });

  it("returns null when MemAvailable is absent", () => {
    expect(parseMemInfo("MemTotal: 2048000 kB")).toBeNull();
  });
});

describe("parseSizeToMb / parseMemUsage / parsePercent", () => {
  it("parses docker size units", () => {
    expect(parseSizeToMb("256MiB")).toBe(256);
    expect(parseSizeToMb("1.5GiB")).toBe(1536);
    expect(parseSizeToMb("512KiB")).toBe(1); // rounds to nearest MB
  });

  it("splits a MemUsage cell into used + limit", () => {
    expect(parseMemUsage("10.5MiB / 256MiB")).toEqual({ usedMb: 11, limitMb: 256 });
  });

  it("parses a CPU percent cell", () => {
    expect(parsePercent("12.34%")).toBeCloseTo(12.34);
    expect(parsePercent("--")).toBe(0);
  });
});

describe("parseDockerStats", () => {
  it("parses one JSON object per line, skipping noise", () => {
    const out = [
      '{"ID":"abc123","Name":"launchpad_blog_api_0","CPUPerc":"50.00%","MemUsage":"128MiB / 256MiB"}',
      "",
      "warning: some stderr leaked in",
      '{"ID":"def456","CPUPerc":"5.00%","MemUsage":"20MiB / 512MiB"}',
    ].join("\n");
    expect(parseDockerStats(out)).toEqual<DockerStatRow[]>([
      { id: "abc123", cpuPercentRaw: 50, memoryUsedMb: 128, memoryLimitMb: 256 },
      { id: "def456", cpuPercentRaw: 5, memoryUsedMb: 20, memoryLimitMb: 512 },
    ]);
  });
});

describe("cpuPercentOfLimit", () => {
  it("normalizes raw docker CPU (% of one core) to % of the cgroup limit", () => {
    // 50% of a core, with a 0.5-core (512 shares) limit → 100% of the limit.
    expect(cpuPercentOfLimit(50, 512)).toBe(100);
    // 50% of a core, 1-core limit → 50% of the limit.
    expect(cpuPercentOfLimit(50, 1024)).toBe(50);
  });

  it("returns the raw percent when no limit is known", () => {
    expect(cpuPercentOfLimit(42, 0)).toBe(42);
  });
});

function replica(over: Partial<ManagedReplica>): ManagedReplica {
  return {
    id: "fullid000000000000000000000000000000000000000000000000000000abc1",
    name: "launchpad_blog_api_0",
    index: 0,
    state: "running",
    project: "blog",
    service: "api",
    image: "img",
    cpu: 256,
    memory: 256,
    hostPort: null,
    ...over,
  };
}

describe("assembleServiceStats", () => {
  it("joins replicas to docker rows by id prefix and normalizes CPU to the limit", () => {
    const replicas = [replica({})];
    const rows: DockerStatRow[] = [
      { id: "fullid000000", cpuPercentRaw: 50, memoryUsedMb: 100, memoryLimitMb: 256 },
    ];
    const shares = cpuSharesByKey([{ project: "blog", service: "api", cpu: 512 }]);
    expect(assembleServiceStats(replicas, rows, shares)).toEqual([
      {
        project: "blog",
        service: "api",
        replica: 0,
        cpuPercent: 100,
        memoryUsedMb: 100,
        memoryLimitMb: 256,
      },
    ]);
  });

  it("skips non-running replicas and zero-fills when no docker row matches", () => {
    const replicas = [
      replica({ index: 0, state: "exited" }),
      replica({ index: 1, name: "launchpad_blog_api_1", id: "unmatchedid111111111111" }),
    ];
    const stats = assembleServiceStats(replicas, [], new Map());
    expect(stats).toEqual([
      {
        project: "blog",
        service: "api",
        replica: 1,
        cpuPercent: 0,
        memoryUsedMb: 0,
        memoryLimitMb: 0,
      },
    ]);
  });
});

describe("createStatsSampler", () => {
  const procStat = "cpu  100 0 50 800 30 0 20 0\n";
  const procStat2 = "cpu  200 0 100 1400 60 0 40 0\n";
  const meminfo = "MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n";

  function deps(overrides: Partial<Parameters<typeof createStatsSampler>[0]["deps"]> = {}) {
    let reads = 0;
    return {
      read: async (path: string) => {
        if (path === "/proc/meminfo") return meminfo;
        reads += 1;
        return reads <= 1 ? procStat : procStat2;
      },
      sleepMs: async () => {},
      dockerStats: async () => "",
      inspect: async () => [],
      now: () => "2026-06-04T00:00:00Z",
      ...overrides,
    };
  }

  it("emits exactly one line, then suppresses until the interval elapses", async () => {
    const lines: string[] = [];
    const sampler = createStatsSampler({
      nodeId: "node-1",
      intervalMs: 60_000,
      includeServices: true,
      emit: (l) => lines.push(l),
      deps: deps(),
    });
    await sampler.maybeSample(0, new Map());
    await sampler.maybeSample(30_000, new Map()); // within interval → skipped
    expect(lines).toHaveLength(1);
    await sampler.maybeSample(60_000, new Map()); // interval elapsed → emits
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.event).toBe("launchpad.stats");
    // delta total = 800, delta idle = 630 → busy = (1 − 630/800)·100 = 21.25 → 21.3
    expect(parsed.host.cpuPercent).toBe(21.3);
    expect(parsed.host.memoryUsedMb).toBe(1000);
  });

  it("is disabled by a non-positive interval", async () => {
    const lines: string[] = [];
    const sampler = createStatsSampler({
      nodeId: "node-1",
      intervalMs: 0,
      includeServices: true,
      emit: (l) => lines.push(l),
      deps: deps(),
    });
    await sampler.maybeSample(0, new Map());
    expect(lines).toHaveLength(0);
  });

  it("still emits host stats when docker sampling throws (degraded-safe)", async () => {
    const lines: string[] = [];
    const warnings: string[] = [];
    const sampler = createStatsSampler({
      nodeId: "node-1",
      intervalMs: 60_000,
      includeServices: true,
      emit: (l) => lines.push(l),
      warn: (m) => warnings.push(m),
      deps: deps({
        inspect: async () => [replica({})],
        dockerStats: async () => {
          throw new Error("docker not running");
        },
      }),
    });
    await sampler.maybeSample(0, new Map());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.host.memoryTotalMb).toBe(2000);
    expect(parsed.services).toEqual([]);
    expect(warnings.join()).toContain("docker not running");
  });
});
