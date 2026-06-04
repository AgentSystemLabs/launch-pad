import ora from "ora";
import type { Ora } from "ora";
import { color, symbols } from "./theme";

// Human-readable output goes to stderr so stdout is reserved for machine output
// (`--json`). In JSON mode, decorative logging is suppressed entirely.
let jsonMode = false;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

function write(line: string): void {
  if (!jsonMode) process.stderr.write(`${line}\n`);
}

export const log = {
  plain: (msg = ""): void => write(msg),
  info: (msg: string): void => write(`${color.blue(symbols.info)} ${msg}`),
  success: (msg: string): void => write(`${color.green(symbols.success)} ${msg}`),
  warn: (msg: string): void => write(`${color.yellow(symbols.warn)} ${msg}`),
  error: (msg: string): void => write(`${color.red(symbols.error)} ${msg}`),
  step: (msg: string): void => write(`${color.cyan(symbols.step)} ${msg}`),
  dim: (msg: string): void => write(color.dim(msg)),
};

/** Print machine-readable JSON to stdout (always, even outside `--json`). */
export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** A spinner bound to stderr; silenced in JSON mode and on non-TTY streams. */
export function spinner(text: string): Ora {
  return ora({ text, stream: process.stderr, isSilent: jsonMode });
}
