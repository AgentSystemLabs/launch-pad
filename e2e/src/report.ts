/**
 * Minimal step/assert reporting for the e2e harness. Human output goes to
 * stderr; a machine-readable summary is printed to stdout at the end. Process
 * exit code reflects pass/fail.
 */

const useColor = process.stderr.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: number, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: (s: string) => paint(2, s),
  red: (s: string) => paint(31, s),
  green: (s: string) => paint(32, s),
  yellow: (s: string) => paint(33, s),
  cyan: (s: string) => paint(36, s),
  bold: (s: string) => paint(1, s),
};

export class AssertionError extends Error {}

interface StepRecord {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const steps: StepRecord[] = [];
let stepCounter = 0;

function err(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function log(line: string): void {
  err(`  ${c.dim(line)}`);
}

export function note(line: string): void {
  err(`  ${c.cyan("›")} ${line}`);
}

/** Run a named step, timing it and recording pass/fail. Re-throws on failure. */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  stepCounter += 1;
  const label = `${c.bold(`[${stepCounter}]`)} ${name}`;
  err(`\n${c.cyan("▶")} ${label}`);
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    steps.push({ name, ok: true, ms });
    err(`  ${c.green("✓")} ${name} ${c.dim(`(${fmt(ms)})`)}`);
    return result;
  } catch (error) {
    const ms = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, ms, error: message });
    err(`  ${c.red("✗")} ${name} ${c.dim(`(${fmt(ms)})`)}`);
    err(`    ${c.red(message.split("\n").join("\n    "))}`);
    throw error;
  }
}

/** Like `step`, but a failure is recorded and swallowed so the run continues
 * (used for independent post-deploy checks — we want the full picture + teardown,
 * not an abort on the first one). The overall run still exits non-zero. */
export async function softStep<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step(name, fn);
  } catch {
    return undefined;
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
  err(`    ${c.green("✓")} ${c.dim(message)}`);
}

export function assertEquals<T>(actual: T, expected: T, message: string): void {
  assert(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), `${message} — "${needle}" not found in: ${truncate(haystack)}`);
}

function truncate(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Print the final JSON summary to stdout + a human tally to stderr. Returns true if all passed. */
export function printSummary(extra: Record<string, unknown> = {}): boolean {
  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.length - passed;
  err("");
  err(c.bold("── e2e summary ──"));
  for (const s of steps) {
    const mark = s.ok ? c.green("✓") : c.red("✗");
    err(`  ${mark} ${s.name} ${c.dim(`(${fmt(s.ms)})`)}`);
  }
  err("");
  err(`  ${passed} passed, ${failed} failed`);
  process.stdout.write(`${JSON.stringify({ passed, failed, steps, ...extra }, null, 2)}\n`);
  return failed === 0;
}
