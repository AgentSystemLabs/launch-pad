/**
 * Resource-usage telemetry contract. Distinct from `status.json` (deploy
 * convergence) and app logs (stdout/stderr): the agent samples host + per-container
 * CPU/memory every interval and emits ONE `launchpad.stats` JSON line to stderr,
 * which the existing system-log pipeline ships to CloudWatch. Both the agent (which
 * builds the line) and the CLI `node monitor` command (which reads it back, from
 * CloudWatch history or a live SSM sample) import this shape so they cannot drift.
 *
 * This is a log-line contract, NOT a `desired.json`/`status.json` wire change — it
 * does **not** bump PROTOCOL_VERSION. New fields must stay additive so an older CLI
 * keeps parsing newer lines (the schema tolerates unknown keys by stripping them).
 */

import { z } from "zod";

/** The discriminator that marks a stats line (and the CloudWatch filter term). */
export const STATS_EVENT = "launchpad.stats" as const;

/** Default sampling cadence; override per-agent with LAUNCHPAD_STATS_INTERVAL_MS. */
export const STATS_DEFAULT_INTERVAL_MS = 60_000;

/** Whole-host utilization at sample time. */
export const HostStatsSchema = z.object({
  /** Host CPU busy %, 0–100 across all cores. */
  cpuPercent: z.number(),
  memoryUsedMb: z.number(),
  memoryTotalMb: z.number(),
});

/** One managed replica's utilization at sample time. */
export const ServiceStatsSchema = z.object({
  project: z.string(),
  service: z.string(),
  replica: z.number().int(),
  /** CPU busy as a % of the replica's cgroup limit (its `--cpus` allocation). */
  cpuPercent: z.number(),
  memoryUsedMb: z.number(),
  memoryLimitMb: z.number(),
});

/** One sampled line emitted by the agent (and by the live SSM sampler). */
export const StatsLineSchema = z.object({
  event: z.literal(STATS_EVENT),
  nodeId: z.string(),
  /** ISO8601 sample time. */
  ts: z.string(),
  host: HostStatsSchema,
  services: z.array(ServiceStatsSchema).default([]),
});

export type HostStats = z.infer<typeof HostStatsSchema>;
export type ServiceStats = z.infer<typeof ServiceStatsSchema>;
export type StatsLine = z.infer<typeof StatsLineSchema>;

export function buildStatsLine(input: {
  nodeId: string;
  ts: string;
  host: HostStats;
  services?: ServiceStats[];
}): StatsLine {
  return {
    event: STATS_EVENT,
    nodeId: input.nodeId,
    ts: input.ts,
    host: input.host,
    services: input.services ?? [],
  };
}

/** Serialize to the single-line JSON the agent writes to stderr. */
export function serializeStatsLine(line: StatsLine): string {
  return JSON.stringify(line);
}

/**
 * Parse one CloudWatch/SSM log message into a {@link StatsLine}, or `null` when it
 * isn't a stats line (a plain agent log, a partial line, or malformed JSON). Cheap
 * pre-checks avoid a JSON.parse on the agent's many non-stats stderr lines.
 */
export function parseStatsLine(raw: string): StatsLine | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes(STATS_EVENT)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = StatsLineSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Host memory utilization as a percentage (0 when total is unknown). */
export function hostMemoryPercent(host: HostStats): number {
  return host.memoryTotalMb > 0 ? (host.memoryUsedMb / host.memoryTotalMb) * 100 : 0;
}
