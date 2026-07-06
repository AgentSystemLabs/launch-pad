import { CliError } from "./errors";

/**
 * Parse `--timeout <seconds>` to milliseconds. A bare `Number()` would turn a typo
 * like `--timeout abc` into NaN, which callers read as an instantly-elapsed deadline.
 * Validate to a positive integer instead.
 */
export function parseTimeoutMs(
  raw: string | undefined,
  defaultSeconds: number,
  invalidHint: string,
): number {
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, { hint: invalidHint });
  }
  return seconds * 1000;
}
