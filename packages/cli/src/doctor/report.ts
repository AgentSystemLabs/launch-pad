/**
 * Result types + pure aggregation for `launch-pad doctor`. The check RUNNERS live
 * in the command (they touch Docker + AWS); this module is the pure, testable core —
 * how a set of results rolls up to an overall pass/fail and a summary.
 */

export type CheckStatus =
  /** Verified good. */
  | "pass"
  /** Works, but with a caveat worth knowing (e.g. golden-AMI fallback → slower boot). */
  | "warn"
  /** Will block a deploy — must be fixed. */
  | "fail"
  /** Not run because a prerequisite failed (e.g. no creds → skip the AWS checks). */
  | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  /** Short result line (what was found). */
  detail: string;
  /** How to fix a warn/fail. */
  hint?: string;
}

/** A deploy can proceed when nothing is in the `fail` state (warn/skip are non-blocking). */
export function overallOk(checks: Check[]): boolean {
  return checks.every((c) => c.status !== "fail");
}

export interface CheckSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

/** Tally the checks by status. */
export function summarize(checks: Check[]): CheckSummary {
  const summary: CheckSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status] += 1;
  return summary;
}
