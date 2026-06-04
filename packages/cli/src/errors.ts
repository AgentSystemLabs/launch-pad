/**
 * An expected, user-facing error. Thrown by commands when something is wrong with
 * input, config, or AWS state. The top-level handler prints `message` (and the
 * optional `hint`) cleanly without a stack trace.
 */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, opts?: { hint?: string; exitCode?: number }) {
    super(message);
    this.name = "CliError";
    this.hint = opts?.hint;
    this.exitCode = opts?.exitCode ?? 1;
  }
}
