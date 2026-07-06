import { CliError } from "./errors";

/**
 * Parse a `--timeout` flag (seconds) to milliseconds. A bare `Number()` would turn a
 * typo like `--timeout abc` into NaN, which timeout waiters read as an instantly-elapsed
 * deadline — the command "times out" the moment it starts with no explanation. Validate
 * to a positive integer instead.
 */
export function resolveTimeoutMs(
  raw: string | undefined,
  defaultSeconds: number,
  hintExampleSeconds: number = defaultSeconds,
): number {
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, {
      hint: `pass whole seconds ≥ 1, e.g. --timeout ${hintExampleSeconds}`,
    });
  }
  return seconds * 1000;
}
