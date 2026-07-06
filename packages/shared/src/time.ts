/** Common duration units in milliseconds. */
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Relative windows like `15m`, `1h`, `7d` (used by CLI `--since`). */
export const RELATIVE_TIME_UNIT_MS = {
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
} as const;

export type RelativeTimeUnit = keyof typeof RELATIVE_TIME_UNIT_MS;
