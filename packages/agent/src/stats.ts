import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import {
  buildStatsLine,
  type HostStats,
  type ServiceStats,
  serializeStatsLine,
  serviceKey,
  type StatsLine,
} from "@agentsystemlabs/launch-pad-shared";
import { inspectManaged, type ManagedReplica } from "./docker";

// ── pure parsing / math ───────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, round1(n)));
}

export interface CpuTimes {
  /** Sum of all jiffy fields on the aggregate `cpu` line. */
  total: number;
  /** Idle + iowait jiffies. */
  idle: number;
}

/** Parse the aggregate `cpu` line of /proc/stat into total + idle jiffies. */
export function parseCpuStat(procStat: string): CpuTimes | null {
  for (const line of procStat.split("\n")) {
    if (!line.startsWith("cpu ")) continue;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 5 || fields.some((n) => Number.isNaN(n))) return null;
    const total = fields.reduce((a, b) => a + b, 0);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    return { total, idle };
  }
  return null;
}

/** Host CPU busy % over the interval between two /proc/stat readings. */
export function cpuPercentFromDelta(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return clampPercent((1 - di / dt) * 100);
}

/** Parse /proc/meminfo into used + total MB (used = MemTotal − MemAvailable). */
export function parseMemInfo(meminfo: string): { memoryUsedMb: number; memoryTotalMb: number } | null {
  let totalKb: number | null = null;
  let availKb: number | null = null;
  for (const line of meminfo.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (!m) continue;
    if (m[1] === "MemTotal") totalKb = Number(m[2]);
    else if (m[1] === "MemAvailable") availKb = Number(m[2]);
  }
  if (totalKb === null || availKb === null) return null;
  const usedKb = Math.max(0, totalKb - availKb);
  return { memoryUsedMb: Math.round(usedKb / 1024), memoryTotalMb: Math.round(totalKb / 1024) };
}

/** Parse a `docker stats` CPU percent string like `"12.34%"` into a number. */
export function parsePercent(s: string): number {
  const n = Number.parseFloat(s.replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

const UNIT_TO_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  KIB: 1 / 1024,
  KB: 1 / 1024,
  MIB: 1,
  MB: 1,
  GIB: 1024,
  GB: 1024,
  TIB: 1024 * 1024,
  TB: 1024 * 1024,
};

/** Parse a docker size like `"10.5MiB"` / `"1.2GiB"` into whole MB. */
export function parseSizeToMb(s: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(s.trim());
  if (!m) return 0;
  const value = Number.parseFloat(m[1] as string);
  const factor = UNIT_TO_MB[(m[2] as string).toUpperCase()] ?? 0;
  return Math.round(value * factor);
}

/** Parse a docker `MemUsage` cell like `"10.5MiB / 256MiB"` into used + limit MB. */
export function parseMemUsage(s: string): { usedMb: number; limitMb: number } {
  const parts = s.split("/");
  return {
    usedMb: parseSizeToMb(parts[0] ?? "0"),
    limitMb: parseSizeToMb(parts[1] ?? "0"),
  };
}

export interface DockerStatRow {
  id: string;
  cpuPercentRaw: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
}

/** Parse `docker stats --no-stream --format '{{json .}}'` output (one JSON object/line). */
export function parseDockerStats(stdout: string): DockerStatRow[] {
  const rows: DockerStatRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: { ID?: string; Container?: string; CPUPerc?: string; MemUsage?: string };
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const id = String(o.ID ?? o.Container ?? "");
    if (!id) continue;
    const mem = parseMemUsage(String(o.MemUsage ?? ""));
    rows.push({
      id,
      cpuPercentRaw: parsePercent(String(o.CPUPerc ?? "0%")),
      memoryUsedMb: mem.usedMb,
      memoryLimitMb: mem.limitMb,
    });
  }
  return rows;
}

/** Normalize raw `docker stats` CPU (% of one core) to % of the cgroup's `--cpus` limit. */
export function cpuPercentOfLimit(rawPercent: number, cpuShares: number): number {
  const cpus = cpuShares / 1024;
  return clampPercent(cpus > 0 ? rawPercent / cpus : rawPercent);
}

/** docker stats `.ID` is a short id; inspect ids are full — match by either prefix. */
function sameContainer(fullId: string, statId: string): boolean {
  return fullId.startsWith(statId) || statId.startsWith(fullId);
}

/**
 * Pure join: one {@link ServiceStats} per running managed replica, normalizing CPU to
 * the replica's desired `--cpus` limit (looked up by `project/service`). Missing docker
 * rows fall back to zero so a replica still appears.
 */
export function assembleServiceStats(
  replicas: ManagedReplica[],
  dockerRows: DockerStatRow[],
  cpuSharesByKey: Map<string, number>,
): ServiceStats[] {
  return replicas
    .filter((r) => r.state === "running")
    .map((r) => {
      const row = dockerRows.find((d) => sameContainer(r.id, d.id));
      const shares = cpuSharesByKey.get(serviceKey(r.project, r.service)) ?? 0;
      return {
        project: r.project,
        service: r.service,
        replica: r.index,
        cpuPercent: row ? cpuPercentOfLimit(row.cpuPercentRaw, shares) : 0,
        memoryUsedMb: row?.memoryUsedMb ?? 0,
        memoryLimitMb: row?.memoryLimitMb ?? 0,
      };
    });
}

// ── sampling (impure, injectable) ───────────────────────────────────────────────────

export interface StatsDeps {
  read: (path: string) => Promise<string>;
  sleepMs: (ms: number) => Promise<void>;
  dockerStats: (ids: string[]) => Promise<string>;
  inspect: () => Promise<ManagedReplica[]>;
  now: () => string;
}

/** How long to hold between the two /proc/stat reads that yield a CPU delta. */
const CPU_SAMPLE_WINDOW_MS = 250;

const defaultDeps: StatsDeps = {
  read: (path) => readFile(path, "utf8"),
  sleepMs: (ms) => sleep(ms),
  dockerStats: async (ids) => {
    const { stdout } = await execa("docker", [
      "stats",
      "--no-stream",
      "--no-trunc",
      "--format",
      "{{json .}}",
      ...ids,
    ]);
    return stdout;
  },
  inspect: async () => [...(await inspectManaged()).values()].flat(),
  now: () => new Date().toISOString(),
};

async function sampleHost(deps: StatsDeps): Promise<HostStats> {
  const a = parseCpuStat(await deps.read("/proc/stat"));
  await deps.sleepMs(CPU_SAMPLE_WINDOW_MS);
  const b = parseCpuStat(await deps.read("/proc/stat"));
  const cpuPercent = a && b ? cpuPercentFromDelta(a, b) : 0;
  const mem = parseMemInfo(await deps.read("/proc/meminfo"));
  return {
    cpuPercent,
    memoryUsedMb: mem?.memoryUsedMb ?? 0,
    memoryTotalMb: mem?.memoryTotalMb ?? 0,
  };
}

/** Best-effort per-service sampling; docker failures degrade to `[]`, never throw. */
async function sampleServices(
  deps: StatsDeps,
  cpuSharesByKey: Map<string, number>,
  onWarn: (msg: string) => void,
): Promise<ServiceStats[]> {
  try {
    const running = (await deps.inspect()).filter((r) => r.id && r.state === "running");
    if (running.length === 0) return [];
    const rows = parseDockerStats(await deps.dockerStats(running.map((r) => r.id)));
    return assembleServiceStats(running, rows, cpuSharesByKey);
  } catch (error) {
    onWarn(error instanceof Error ? error.message : String(error));
    return [];
  }
}

export interface StatsSamplerOptions {
  nodeId: string;
  intervalMs: number;
  /** Include the per-service array (default true); set false for host-only on tiny nodes. */
  includeServices: boolean;
  emit?: (line: string) => void;
  warn?: (message: string) => void;
  deps?: Partial<StatsDeps>;
}

export interface StatsSampler {
  /**
   * Emit one stats line if at least `intervalMs` has elapsed since the last emit.
   * Degraded-safe: any sampling/IO failure is swallowed (warned once) so it can never
   * break the reconcile tick. A non-positive interval disables sampling entirely.
   */
  maybeSample(at: number, cpuSharesByKey: Map<string, number>): Promise<void>;
  /** Build (but do not emit) one stats line — used by tests and one-shot callers. */
  sampleOnce(cpuSharesByKey: Map<string, number>): Promise<StatsLine>;
}

export function createStatsSampler(options: StatsSamplerOptions): StatsSampler {
  const deps: StatsDeps = { ...defaultDeps, ...options.deps };
  const emit = options.emit ?? ((line: string) => console.error(line));
  const warn = options.warn ?? ((m: string) => console.error(`[agent] stats: ${m}`));
  let lastEmit = Number.NEGATIVE_INFINITY;
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    warn(`sampling failed (continuing): ${message}`);
  };

  async function sampleOnce(cpuSharesByKey: Map<string, number>): Promise<StatsLine> {
    const host = await sampleHost(deps);
    const services = options.includeServices
      ? await sampleServices(deps, cpuSharesByKey, warnOnce)
      : [];
    return buildStatsLine({ nodeId: options.nodeId, ts: deps.now(), host, services });
  }

  return {
    sampleOnce,
    async maybeSample(at: number, cpuSharesByKey: Map<string, number>): Promise<void> {
      if (options.intervalMs <= 0) return;
      if (at - lastEmit < options.intervalMs) return;
      lastEmit = at; // gate before sampling so a slow/failed sample still backs off
      try {
        emit(serializeStatsLine(await sampleOnce(cpuSharesByKey)));
        warned = false;
      } catch (error) {
        warnOnce(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Build the `serviceKey → cpu shares` map used to normalize per-replica CPU. */
export function cpuSharesByKey(
  services: Array<{ project: string; service: string; cpu: number }>,
): Map<string, number> {
  return new Map(services.map((s) => [serviceKey(s.project, s.service), s.cpu]));
}
