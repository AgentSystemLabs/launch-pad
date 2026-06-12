/**
 * Minimal 5-field cron evaluator for `[[service]].cron` scheduled workers.
 *
 * Semantics (vixie-cron compatible, evaluated in UTC):
 *   field order: minute hour day-of-month month day-of-week
 *   per field:   `*`, N, N-M, lists (`a,b,c`), steps (`* /k` without the space, `N-M/k`, `N/k` = N-max/k)
 *   dow:         0-7 where both 0 and 7 are Sunday
 *   dom + dow:   when BOTH are restricted, a minute matches on EITHER (vixie rule)
 *   names:       deliberately unsupported (numeric only) — keeps parsing unambiguous
 *
 * Zero dependencies and fully pure so the due-run decision (agent) and the
 * config validation (CLI) share one implementation that's unit-testable.
 */

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  months: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  /** True when the field was not `*` — drives the vixie dom-OR-dow rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MINUTE_MS = 60_000;

/**
 * How far the fire-time scans look before giving up. 366 days covers every
 * yearly schedule with at least one real date; anything that never matches in
 * a year (e.g. `0 0 30 2 *` — Feb 30) is treated as never firing.
 */
const SCAN_HORIZON_MINUTES = 366 * 24 * 60;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export const CRON_EXPRESSION_HINT =
  "5 space-separated fields: minute hour day-of-month month day-of-week (numeric; `*`, lists, ranges, and `/step` allowed; evaluated in UTC)";

function parseNumber(token: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`${spec.name} field has invalid value "${token}"`);
  }
  const n = Number.parseInt(token, 10);
  if (n < spec.min || n > spec.max) {
    throw new Error(`${spec.name} field value ${n} is out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

/** Expand one comma-separated item (`*`, N, N-M, with optional `/step`) into values. */
function expandItem(item: string, spec: FieldSpec): number[] {
  const parts = item.split("/");
  const rangePart = parts[0] ?? "";
  const stepPart = parts[1];
  if (parts.length > 2 || stepPart === "") {
    throw new Error(`${spec.name} field has invalid step in "${item}"`);
  }
  let step = 1;
  if (stepPart !== undefined) {
    if (!/^\d+$/.test(stepPart) || Number.parseInt(stepPart, 10) === 0) {
      throw new Error(`${spec.name} field has invalid step in "${item}" — step must be a positive integer`);
    }
    step = Number.parseInt(stepPart, 10);
  }

  let lo: number;
  let hi: number;
  if (rangePart === "*" || rangePart === "") {
    if (rangePart === "") throw new Error(`${spec.name} field has an empty value`);
    lo = spec.min;
    hi = spec.max;
  } else if (rangePart.includes("-")) {
    const [a, b, ...rest] = rangePart.split("-");
    if (rest.length > 0 || a === "" || b === "" || a === undefined || b === undefined) {
      throw new Error(`${spec.name} field has invalid range "${rangePart}"`);
    }
    lo = parseNumber(a, spec);
    hi = parseNumber(b, spec);
    if (lo > hi) throw new Error(`${spec.name} field has an inverted range "${rangePart}"`);
  } else {
    lo = parseNumber(rangePart, spec);
    // `N/step` means N through max (vixie); a bare `N` is just N.
    hi = stepPart !== undefined ? spec.max : lo;
  }

  const values: number[] = [];
  for (let v = lo; v <= hi; v += step) values.push(v);
  return values;
}

function parseField(field: string, spec: FieldSpec): { values: Set<number>; restricted: boolean } {
  if (field === "*") {
    const all = new Set<number>();
    for (let v = spec.min; v <= spec.max; v += 1) all.add(v);
    return { values: all, restricted: false };
  }
  const values = new Set<number>();
  for (const item of field.split(",")) {
    for (const v of expandItem(item, spec)) values.add(v);
  }
  // `*/k` restricts the set but still counts as restricted=false only for a bare
  // `*`; vixie treats `*/k` in dom/dow as restricted, and so do we.
  return { values, restricted: true };
}

/** Parse a 5-field cron expression. Throws with a field-specific message. */
export function parseCronExpression(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/).filter((f) => f.length > 0);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields — ${CRON_EXPRESSION_HINT}`);
  }
  const parsed = fields.map((f, i) => parseField(f, FIELDS[i] as FieldSpec));
  const [minutes, hours, dom, months, dow] = parsed as [
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
  ];

  // Normalize dow 7 → 0 so matching only ever checks 0-6.
  const dowValues = new Set<number>();
  for (const v of dow.values) dowValues.add(v === 7 ? 0 : v);

  return {
    minutes: minutes.values,
    hours: hours.values,
    dom: dom.values,
    months: months.values,
    dow: dowValues,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

/** Returns a validation message, or null when the cron expression is well formed. */
export function cronExpressionError(expr: string): string | null {
  try {
    parseCronExpression(expr);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** True when the UTC minute containing `ms` matches the schedule. */
export function cronMatchesMinute(s: CronSchedule, ms: number): boolean {
  const d = new Date(ms);
  if (!s.minutes.has(d.getUTCMinutes())) return false;
  if (!s.hours.has(d.getUTCHours())) return false;
  if (!s.months.has(d.getUTCMonth() + 1)) return false;

  const domMatch = s.dom.has(d.getUTCDate());
  const dowMatch = s.dow.has(d.getUTCDay());
  // Vixie rule: both restricted → OR; otherwise each restricted field must match
  // (an unrestricted `*` always matches).
  if (s.domRestricted && s.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The first fire time strictly AFTER `afterMs`, or null when none exists within
 * the scan horizon (an impossible date like Feb 30).
 */
export function nextCronFire(s: CronSchedule, afterMs: number): number | null {
  let t = floorToMinute(afterMs) + MINUTE_MS;
  for (let i = 0; i < SCAN_HORIZON_MINUTES; i += 1, t += MINUTE_MS) {
    if (cronMatchesMinute(s, t)) return t;
  }
  return null;
}

/**
 * The run that is DUE now: the latest fire time `t` with lastFireMs < t <= nowMs,
 * or null when nothing fired since the last run. Multiple missed fires (agent
 * down, long previous run) deliberately collapse to the single latest one so a
 * recovering node never storms through a backlog.
 */
export function dueCronFire(s: CronSchedule, lastFireMs: number, nowMs: number): number | null {
  const floor = Math.max(lastFireMs, nowMs - SCAN_HORIZON_MINUTES * MINUTE_MS);
  for (let t = floorToMinute(nowMs); t > floor; t -= MINUTE_MS) {
    if (cronMatchesMinute(s, t)) return t;
  }
  return null;
}
