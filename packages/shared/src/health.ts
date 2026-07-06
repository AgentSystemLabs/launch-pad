import { z } from "zod";
import { MINUTE_MS, SECOND_MS } from "./time";

/** Pattern for rollout/health duration strings like "20s", "500ms", "1m". */
const DURATION_PATTERN = /^(\d+)(ms|s|m)$/;

/** A duration string like "20s", "500ms", "1m". */
export const DurationSchema = z
  .string()
  .regex(DURATION_PATTERN, 'duration must look like "20s", "500ms", or "1m"');

/** Parse a duration string to milliseconds. */
export function parseDurationMs(duration: string): number {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) return 0;
  const n = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * SECOND_MS;
    case "m":
      return n * MINUTE_MS;
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
