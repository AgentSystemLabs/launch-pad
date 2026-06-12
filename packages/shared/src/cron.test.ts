import { describe, expect, it } from "vitest";
import {
  cronExpressionError,
  dueCronFire,
  nextCronFire,
  parseCronExpression,
} from "./cron";

/** Minute-aligned UTC timestamp for readable tests. */
function utc(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad iso in test: ${iso}`);
  return ms;
}

describe("cronExpressionError", () => {
  it("accepts the common shapes", () => {
    for (const expr of [
      "* * * * *",
      "*/5 * * * *",
      "0 0 * * *",
      "15 14 1 * *",
      "0 22 * * 1-5",
      "23 0-20/2 * * *",
      "5 4 * * 0",
      "5 4 * * 7", // 7 == Sunday
      "0,30 9-17 * * 1,3,5",
      "10-40/10 */2 1-15 1,6,12 *",
    ]) {
      expect(cronExpressionError(expr), expr).toBeNull();
    }
  });

  it("rejects malformed expressions with a useful message", () => {
    expect(cronExpressionError("* * * *")).toMatch(/5 fields/);
    expect(cronExpressionError("* * * * * *")).toMatch(/5 fields/);
    expect(cronExpressionError("60 * * * *")).toMatch(/minute/);
    expect(cronExpressionError("* 24 * * *")).toMatch(/hour/);
    expect(cronExpressionError("* * 0 * *")).toMatch(/day of month/);
    expect(cronExpressionError("* * 32 * *")).toMatch(/day of month/);
    expect(cronExpressionError("* * * 13 *")).toMatch(/month/);
    expect(cronExpressionError("* * * 0 *")).toMatch(/month/);
    expect(cronExpressionError("* * * * 8")).toMatch(/day of week/);
    expect(cronExpressionError("a * * * *")).toMatch(/minute/);
    expect(cronExpressionError("1- * * * *")).toMatch(/minute/);
    expect(cronExpressionError("5-1 * * * *")).toMatch(/range/);
    expect(cronExpressionError("*/0 * * * *")).toMatch(/step/);
    expect(cronExpressionError("*/x * * * *")).toMatch(/step/);
    expect(cronExpressionError("")).toMatch(/5 fields/);
    // Names are deliberately unsupported in v1 (numeric only).
    expect(cronExpressionError("* * * JAN *")).toMatch(/month/);
    expect(cronExpressionError("* * * * MON")).toMatch(/day of week/);
  });
});

describe("nextCronFire", () => {
  it("every minute fires at the next minute boundary", () => {
    const s = parseCronExpression("* * * * *");
    expect(nextCronFire(s, utc("2026-06-11T10:00:00Z"))).toBe(utc("2026-06-11T10:01:00Z"));
    expect(nextCronFire(s, utc("2026-06-11T10:00:30Z"))).toBe(utc("2026-06-11T10:01:00Z"));
    expect(nextCronFire(s, utc("2026-06-11T10:00:59.999Z"))).toBe(utc("2026-06-11T10:01:00Z"));
  });

  it("*/5 fires on the next multiple of five", () => {
    const s = parseCronExpression("*/5 * * * *");
    expect(nextCronFire(s, utc("2026-06-11T10:01:00Z"))).toBe(utc("2026-06-11T10:05:00Z"));
    expect(nextCronFire(s, utc("2026-06-11T10:05:00Z"))).toBe(utc("2026-06-11T10:10:00Z"));
  });

  it("daily at midnight UTC rolls to the next day", () => {
    const s = parseCronExpression("0 0 * * *");
    expect(nextCronFire(s, utc("2026-06-11T00:00:00Z"))).toBe(utc("2026-06-12T00:00:00Z"));
    expect(nextCronFire(s, utc("2026-06-11T13:37:11Z"))).toBe(utc("2026-06-12T00:00:00Z"));
  });

  it("weekday-only schedules skip the weekend (dow 1-5)", () => {
    const s = parseCronExpression("0 9 * * 1-5");
    // 2026-06-12 is a Friday; the next 9:00 after Friday's is Monday 2026-06-15.
    expect(nextCronFire(s, utc("2026-06-12T09:00:00Z"))).toBe(utc("2026-06-15T09:00:00Z"));
  });

  it("dow 7 means Sunday", () => {
    const s = parseCronExpression("0 6 * * 7");
    // 2026-06-11 is a Thursday → next Sunday is 2026-06-14.
    expect(nextCronFire(s, utc("2026-06-11T00:00:00Z"))).toBe(utc("2026-06-14T06:00:00Z"));
  });

  it("restricted dom AND dow match on EITHER (vixie cron)", () => {
    // The 15th of the month OR any Monday.
    const s = parseCronExpression("0 0 15 * 1");
    // From Thu 2026-06-11: Monday 2026-06-15 and dom-15 2026-06-15 coincide;
    // the first fire after Fri 2026-06-12 is Mon/15th 2026-06-15.
    expect(nextCronFire(s, utc("2026-06-12T00:00:00Z"))).toBe(utc("2026-06-15T00:00:00Z"));
    // And after the 15th, the next is Monday the 22nd (dow), before dom 15 July.
    expect(nextCronFire(s, utc("2026-06-15T00:00:00Z"))).toBe(utc("2026-06-22T00:00:00Z"));
  });

  it("returns null when no fire exists within the scan horizon (Feb 30)", () => {
    const s = parseCronExpression("0 0 30 2 *");
    expect(nextCronFire(s, utc("2026-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("dueCronFire", () => {
  const everyFive = parseCronExpression("*/5 * * * *");

  it("not due when no fire time has passed since the last fire", () => {
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:07:30Z")),
    ).toBeNull();
  });

  it("due exactly at the fire minute", () => {
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:10:00Z")),
    ).toBe(utc("2026-06-11T10:10:00Z"));
  });

  it("due mid-minute after the fire", () => {
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:10:09Z")),
    ).toBe(utc("2026-06-11T10:10:00Z"));
  });

  it("multiple missed fires collapse to the LATEST one (no run storm)", () => {
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T11:02:00Z")),
    ).toBe(utc("2026-06-11T11:00:00Z"));
  });

  it("an anchor set mid-window does not fire for earlier minutes", () => {
    // Anchored at 10:07:30 (first sight) — the 10:05 fire is in the past, not due.
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:07:30Z"), utc("2026-06-11T10:09:00Z")),
    ).toBeNull();
    // ...but 10:10 becomes due.
    expect(
      dueCronFire(everyFive, utc("2026-06-11T10:07:30Z"), utc("2026-06-11T10:10:00Z")),
    ).toBe(utc("2026-06-11T10:10:00Z"));
  });

  it("never returns a fire at or before lastFireMs", () => {
    const s = parseCronExpression("* * * * *");
    expect(dueCronFire(s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:05:00Z"))).toBeNull();
    expect(dueCronFire(s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:05:59Z"))).toBeNull();
  });

  it("handles a sparse schedule with a long gap (weekly)", () => {
    const weekly = parseCronExpression("0 3 * * 1");
    // Last fired Mon 2026-06-08 03:00; now Wed → not due; next Mon → due.
    expect(dueCronFire(weekly, utc("2026-06-08T03:00:00Z"), utc("2026-06-10T12:00:00Z"))).toBeNull();
    expect(dueCronFire(weekly, utc("2026-06-08T03:00:00Z"), utc("2026-06-15T03:00:30Z"))).toBe(
      utc("2026-06-15T03:00:00Z"),
    );
  });
});
