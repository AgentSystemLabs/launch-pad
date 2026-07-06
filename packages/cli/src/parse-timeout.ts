import { CliError } from "./errors";

const MS_PER_SECOND = 1000;

export interface ParseTimeoutOptions {
  /** Seconds to use when `raw` is omitted. */
  defaultSeconds: number;
  /** Example value shown in the invalid-input hint (defaults to `defaultSeconds`). */
  exampleSeconds?: number;
}

/**
 * Parse `--timeout <seconds>` to a positive integer in seconds.
 *
 * A bare `Number()` would turn a typo like `--timeout abc` into NaN, which
 * timeout wait loops read as an instantly-elapsed deadline. Validate to a
 * positive integer instead.
 */
export function parseTimeoutSeconds(raw: string | undefined, opts: ParseTimeoutOptions): number {
  if (raw === undefined) return opts.defaultSeconds;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    const example = opts.exampleSeconds ?? opts.defaultSeconds;
    throw new CliError(`invalid --timeout "${raw}"`, {
      hint: `pass whole seconds ≥ 1, e.g. --timeout ${example}`,
    });
  }
  return seconds;
}

/** Like {@link parseTimeoutSeconds}, but returns milliseconds. */
export function resolveTimeoutMs(raw: string | undefined, opts: ParseTimeoutOptions): number {
  return parseTimeoutSeconds(raw, opts) * MS_PER_SECOND;
}
