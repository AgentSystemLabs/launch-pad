import { z } from "zod";

/** Milliseconds per relative-time unit (`15m`, `1h`, `7d`, etc.). */
export const TIME_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export type TimeUnit = keyof typeof TIME_UNIT_MS;

/** A duration string like "20s", "500ms", "1m". */
export const DurationSchema = z
  .string()
  .regex(/^\d+(ms|s|m)$/, 'duration must look like "20s", "500ms", or "1m"');

/** Parse a duration string to milliseconds. */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(duration);
  if (!match) return 0;
  const n = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * TIME_UNIT_MS.s;
    case "m":
      return n * TIME_UNIT_MS.m;
    default:
      return 0;
  }
}

/**
 * HTTP health check for a web service. `port` defaults to the service's ingress
 * port at run time (the agent falls back to it when unset).
 */
export const HealthCheckSchema = z
  .object({
    path: z.string().startsWith("/", "healthCheck.path must start with /"),
    port: z.number().int().min(1).max(65535).optional(),
    intervalMs: z.number().int().positive().default(2000),
    timeoutMs: z.number().int().positive().default(2000),
    healthyThreshold: z.number().int().positive().default(2),
  })
  .strict();
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** Rolling-update policy. */
export const RolloutSchema = z
  .object({
    maxSurge: z.number().int().min(1).default(1),
    drainTimeout: DurationSchema.default("20s"),
    stopGrace: DurationSchema.default("30s"),
  })
  .strict();
export type Rollout = z.infer<typeof RolloutSchema>;

export const DEFAULT_ROLLOUT: Rollout = {
  maxSurge: 1,
  drainTimeout: "20s",
  stopGrace: "30s",
};
