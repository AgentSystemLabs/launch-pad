import { CliError } from "./errors.js";

/**
 * Parse the `--timeout` flag (seconds) to milliseconds. A bare `Number()` would turn
 * a typo like `--timeout abc` into NaN, which wait loops read as an instantly-elapsed
 * deadline — a command that "times out" the moment it starts with no explanation.
 */
export function parseTimeoutSeconds(raw: string | undefined, defaultSeconds: number): number {
  if (raw === undefined) return defaultSeconds * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, {
      hint: `pass whole seconds ≥ 1, e.g. --timeout ${defaultSeconds}`,
    });
  }
  return seconds * 1000;
}
