import { CliError } from "./errors";

/**
 * Parse a `--timeout` flag (whole seconds) to milliseconds. A bare `Number()` would
 * turn a typo like `--timeout abc` into NaN, which callers read as an instantly-elapsed
 * deadline — a command that "times out" the moment it starts with no explanation.
 */
export function resolveTimeoutSecondsMs(
  raw: string | undefined,
  defaultSeconds: number,
  exampleSeconds: number = defaultSeconds,
): number {
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, {
      hint: `pass whole seconds ≥ 1, e.g. --timeout ${exampleSeconds}`,
    });
  }
  return seconds * 1000;
}
