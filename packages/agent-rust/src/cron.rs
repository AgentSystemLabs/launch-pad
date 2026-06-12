//! Minimal 5-field cron evaluator for `[[service]].cron` scheduled workers.
//! Port of `packages/shared/src/cron.ts` — keep the two in lock-step.
//!
//! Semantics (vixie-cron compatible, evaluated in UTC):
//!   field order: minute hour day-of-month month day-of-week
//!   per field:   `*`, N, N-M, lists (`a,b,c`), steps (`*/k`, `N-M/k`, `N/k` = N-max/k)
//!   dow:         0-7 where both 0 and 7 are Sunday
//!   dom + dow:   when BOTH are restricted, a minute matches on EITHER (vixie rule)
//!   names:       deliberately unsupported (numeric only) — keeps parsing unambiguous
//!
//! Fully pure so the due-run decision is unit-testable without a clock.

use std::collections::BTreeSet;

use chrono::{DateTime, Datelike, Timelike, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    pub minutes: BTreeSet<i64>,
    pub hours: BTreeSet<i64>,
    pub dom: BTreeSet<i64>,
    pub months: BTreeSet<i64>,
    pub dow: BTreeSet<i64>,
    /// True when the field was not `*` — drives the vixie dom-OR-dow rule.
    pub dom_restricted: bool,
    pub dow_restricted: bool,
}

const MINUTE_MS: i64 = 60_000;

/// How far the fire-time scans look before giving up. 366 days covers every
/// yearly schedule with at least one real date; anything that never matches in
/// a year (e.g. `0 0 30 2 *` — Feb 30) is treated as never firing.
const SCAN_HORIZON_MINUTES: i64 = 366 * 24 * 60;

struct FieldSpec {
    name: &'static str,
    min: i64,
    max: i64,
}

const FIELDS: [FieldSpec; 5] = [
    FieldSpec { name: "minute", min: 0, max: 59 },
    FieldSpec { name: "hour", min: 0, max: 23 },
    FieldSpec { name: "day of month", min: 1, max: 31 },
    FieldSpec { name: "month", min: 1, max: 12 },
    FieldSpec { name: "day of week", min: 0, max: 7 },
];

pub const CRON_EXPRESSION_HINT: &str = "5 space-separated fields: minute hour day-of-month month day-of-week (numeric; `*`, lists, ranges, and `/step` allowed; evaluated in UTC)";

fn parse_number(token: &str, spec: &FieldSpec) -> Result<i64, String> {
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("{} field has invalid value \"{token}\"", spec.name));
    }
    let n: i64 = token
        .parse()
        .map_err(|_| format!("{} field has invalid value \"{token}\"", spec.name))?;
    if n < spec.min || n > spec.max {
        return Err(format!(
            "{} field value {n} is out of range {}-{}",
            spec.name, spec.min, spec.max
        ));
    }
    Ok(n)
}

/// Expand one comma-separated item (`*`, N, N-M, with optional `/step`) into values.
fn expand_item(item: &str, spec: &FieldSpec) -> Result<Vec<i64>, String> {
    let parts: Vec<&str> = item.split('/').collect();
    let range_part = parts.first().copied().unwrap_or("");
    let step_part = parts.get(1).copied();
    if parts.len() > 2 || step_part == Some("") {
        return Err(format!("{} field has invalid step in \"{item}\"", spec.name));
    }
    let mut step = 1;
    if let Some(s) = step_part {
        if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) || s.parse::<i64>() == Ok(0) {
            return Err(format!(
                "{} field has invalid step in \"{item}\" — step must be a positive integer",
                spec.name
            ));
        }
        step = s.parse::<i64>().map_err(|_| {
            format!(
                "{} field has invalid step in \"{item}\" — step must be a positive integer",
                spec.name
            )
        })?;
    }

    let (lo, hi) = if range_part == "*" || range_part.is_empty() {
        if range_part.is_empty() {
            return Err(format!("{} field has an empty value", spec.name));
        }
        (spec.min, spec.max)
    } else if range_part.contains('-') {
        let pieces: Vec<&str> = range_part.split('-').collect();
        if pieces.len() != 2 || pieces[0].is_empty() || pieces[1].is_empty() {
            return Err(format!(
                "{} field has invalid range \"{range_part}\"",
                spec.name
            ));
        }
        let lo = parse_number(pieces[0], spec)?;
        let hi = parse_number(pieces[1], spec)?;
        if lo > hi {
            return Err(format!(
                "{} field has an inverted range \"{range_part}\"",
                spec.name
            ));
        }
        (lo, hi)
    } else {
        let lo = parse_number(range_part, spec)?;
        // `N/step` means N through max (vixie); a bare `N` is just N.
        let hi = if step_part.is_some() { spec.max } else { lo };
        (lo, hi)
    };

    let mut values = Vec::new();
    let mut v = lo;
    while v <= hi {
        values.push(v);
        v += step;
    }
    Ok(values)
}

struct ParsedField {
    values: BTreeSet<i64>,
    restricted: bool,
}

fn parse_field(field: &str, spec: &FieldSpec) -> Result<ParsedField, String> {
    if field == "*" {
        let values: BTreeSet<i64> = (spec.min..=spec.max).collect();
        return Ok(ParsedField { values, restricted: false });
    }
    let mut values = BTreeSet::new();
    for item in field.split(',') {
        for v in expand_item(item, spec)? {
            values.insert(v);
        }
    }
    // `*/k` restricts the set; only a bare `*` counts as unrestricted (vixie).
    Ok(ParsedField { values, restricted: true })
}

/// Parse a 5-field cron expression. Errs with a field-specific message.
pub fn parse_cron_expression(expr: &str) -> Result<CronSchedule, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "cron expression must have exactly 5 fields — {CRON_EXPRESSION_HINT}"
        ));
    }
    let minutes = parse_field(fields[0], &FIELDS[0])?;
    let hours = parse_field(fields[1], &FIELDS[1])?;
    let dom = parse_field(fields[2], &FIELDS[2])?;
    let months = parse_field(fields[3], &FIELDS[3])?;
    let dow = parse_field(fields[4], &FIELDS[4])?;

    // Normalize dow 7 → 0 so matching only ever checks 0-6.
    let dow_values: BTreeSet<i64> = dow.values.iter().map(|&v| if v == 7 { 0 } else { v }).collect();

    Ok(CronSchedule {
        minutes: minutes.values,
        hours: hours.values,
        dom: dom.values,
        months: months.values,
        dow: dow_values,
        dom_restricted: dom.restricted,
        dow_restricted: dow.restricted,
    })
}

/// A validation message, or None when the cron expression is well formed.
pub fn cron_expression_error(expr: &str) -> Option<String> {
    parse_cron_expression(expr).err()
}

/// True when the UTC minute containing `ms` matches the schedule.
pub fn cron_matches_minute(s: &CronSchedule, ms: i64) -> bool {
    let Some(d): Option<DateTime<Utc>> = DateTime::from_timestamp_millis(ms) else {
        return false;
    };
    if !s.minutes.contains(&i64::from(d.minute())) {
        return false;
    }
    if !s.hours.contains(&i64::from(d.hour())) {
        return false;
    }
    if !s.months.contains(&i64::from(d.month())) {
        return false;
    }

    let dom_match = s.dom.contains(&i64::from(d.day()));
    let dow_match = s.dow.contains(&i64::from(d.weekday().num_days_from_sunday()));
    // Vixie rule: both restricted → OR; otherwise each restricted field must match
    // (an unrestricted `*` always matches).
    if s.dom_restricted && s.dow_restricted {
        return dom_match || dow_match;
    }
    dom_match && dow_match
}

fn floor_to_minute(ms: i64) -> i64 {
    ms.div_euclid(MINUTE_MS) * MINUTE_MS
}

/// The first fire time strictly AFTER `after_ms`, or None when none exists within
/// the scan horizon (an impossible date like Feb 30).
pub fn next_cron_fire(s: &CronSchedule, after_ms: i64) -> Option<i64> {
    let mut t = floor_to_minute(after_ms) + MINUTE_MS;
    for _ in 0..SCAN_HORIZON_MINUTES {
        if cron_matches_minute(s, t) {
            return Some(t);
        }
        t += MINUTE_MS;
    }
    None
}

/// The run that is DUE now: the latest fire time `t` with last_fire_ms < t <= now_ms,
/// or None when nothing fired since the last run. Multiple missed fires (agent
/// down, long previous run) deliberately collapse to the single latest one so a
/// recovering node never storms through a backlog.
pub fn due_cron_fire(s: &CronSchedule, last_fire_ms: i64, now_ms: i64) -> Option<i64> {
    let floor = last_fire_ms.max(now_ms - SCAN_HORIZON_MINUTES * MINUTE_MS);
    let mut t = floor_to_minute(now_ms);
    while t > floor {
        if cron_matches_minute(s, t) {
            return Some(t);
        }
        t -= MINUTE_MS;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(iso: &str) -> i64 {
        DateTime::parse_from_rfc3339(iso).unwrap().timestamp_millis()
    }

    #[test]
    fn accepts_the_common_shapes() {
        for expr in [
            "* * * * *",
            "*/5 * * * *",
            "0 * * * *",
            "30 2 * * *",
            "0 0 * * 0",
            "0 0 * * 7",
            "15,45 9-17 * * 1-5",
            "0 6 1 1 *",
            "0 0 1-15/2 * *",
            "5/10 * * * *",
        ] {
            assert!(cron_expression_error(expr).is_none(), "{expr}");
        }
    }

    #[test]
    fn rejects_malformed_expressions_with_a_useful_message() {
        let has = |expr: &str, needle: &str| {
            let err = cron_expression_error(expr).unwrap_or_else(|| panic!("{expr} should err"));
            assert!(err.contains(needle), "{expr}: {err}");
        };
        has("* * * *", "5 fields");
        has("* * * * * *", "5 fields");
        has("60 * * * *", "minute");
        has("* 24 * * *", "hour");
        has("* * 0 * *", "day of month");
        has("* * 32 * *", "day of month");
        has("* * * 13 *", "month");
        has("* * * 0 *", "month");
        has("* * * * 8", "day of week");
        has("a * * * *", "minute");
        has("1- * * * *", "minute");
        has("5-1 * * * *", "range");
        has("*/0 * * * *", "step");
        has("*/x * * * *", "step");
        has("", "5 fields");
        has("* * * JAN *", "month");
        has("* * * * MON", "day of week");
    }

    #[test]
    fn every_minute_fires_at_the_next_minute_boundary() {
        let s = parse_cron_expression("* * * * *").unwrap();
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T10:00:00Z")), Some(utc("2026-06-11T10:01:00Z")));
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T10:00:30Z")), Some(utc("2026-06-11T10:01:00Z")));
        assert_eq!(
            next_cron_fire(&s, utc("2026-06-11T10:00:59.999Z")),
            Some(utc("2026-06-11T10:01:00Z"))
        );
    }

    #[test]
    fn every_five_fires_on_the_next_multiple_of_five() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T10:01:00Z")), Some(utc("2026-06-11T10:05:00Z")));
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T10:05:00Z")), Some(utc("2026-06-11T10:10:00Z")));
    }

    #[test]
    fn daily_at_midnight_utc_rolls_to_the_next_day() {
        let s = parse_cron_expression("0 0 * * *").unwrap();
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T00:00:00Z")), Some(utc("2026-06-12T00:00:00Z")));
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T13:37:11Z")), Some(utc("2026-06-12T00:00:00Z")));
    }

    #[test]
    fn weekday_only_schedules_skip_the_weekend() {
        // 2026-06-12 is a Friday; the 9:00 fire after Friday 9:00 is Monday the 15th.
        let s = parse_cron_expression("0 9 * * 1-5").unwrap();
        assert_eq!(next_cron_fire(&s, utc("2026-06-12T09:00:00Z")), Some(utc("2026-06-15T09:00:00Z")));
    }

    #[test]
    fn dow_7_means_sunday() {
        // 2026-06-14 is a Sunday.
        let s = parse_cron_expression("0 6 * * 7").unwrap();
        assert_eq!(next_cron_fire(&s, utc("2026-06-11T00:00:00Z")), Some(utc("2026-06-14T06:00:00Z")));
    }

    #[test]
    fn restricted_dom_and_dow_match_on_either() {
        // Vixie: `0 0 15 * 1` fires on the 15th OR on Mondays.
        let s = parse_cron_expression("0 0 15 * 1").unwrap();
        // 2026-06-15 is both the 15th and a Monday.
        assert_eq!(next_cron_fire(&s, utc("2026-06-12T00:00:00Z")), Some(utc("2026-06-15T00:00:00Z")));
        // After the 15th: next Monday (the 22nd) — dow alone matches.
        assert_eq!(next_cron_fire(&s, utc("2026-06-15T00:00:00Z")), Some(utc("2026-06-22T00:00:00Z")));
    }

    #[test]
    fn returns_none_when_no_fire_exists_within_the_scan_horizon() {
        let s = parse_cron_expression("0 0 30 2 *").unwrap(); // Feb 30 never exists
        assert_eq!(next_cron_fire(&s, utc("2026-01-01T00:00:00Z")), None);
    }

    #[test]
    fn not_due_when_no_fire_time_has_passed_since_the_last_fire() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:07:00Z")),
            None
        );
    }

    #[test]
    fn due_exactly_at_the_fire_minute() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:10:00Z")),
            Some(utc("2026-06-11T10:10:00Z"))
        );
    }

    #[test]
    fn due_mid_minute_after_the_fire() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:10:42Z")),
            Some(utc("2026-06-11T10:10:00Z"))
        );
    }

    #[test]
    fn multiple_missed_fires_collapse_to_the_latest_one() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T11:02:00Z")),
            Some(utc("2026-06-11T11:00:00Z"))
        );
    }

    #[test]
    fn an_anchor_set_mid_window_does_not_fire_for_earlier_minutes() {
        let s = parse_cron_expression("0 0 * * *").unwrap();
        // Anchored at 10:30 on the 11th: midnight on the 11th already passed → not due.
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:30:00Z"), utc("2026-06-11T23:59:00Z")),
            None
        );
        // The next midnight IS due.
        assert_eq!(
            due_cron_fire(&s, utc("2026-06-11T10:30:00Z"), utc("2026-06-12T00:00:30Z")),
            Some(utc("2026-06-12T00:00:00Z"))
        );
    }

    #[test]
    fn never_returns_a_fire_at_or_before_last_fire_ms() {
        let s = parse_cron_expression("*/5 * * * *").unwrap();
        assert_eq!(due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:05:00Z")), None);
        assert_eq!(due_cron_fire(&s, utc("2026-06-11T10:05:00Z"), utc("2026-06-11T10:05:59Z")), None);
    }

    #[test]
    fn handles_a_sparse_schedule_with_a_long_gap() {
        // Weekly: Mondays at 03:00. 2026-06-08 and 2026-06-15 are Mondays.
        let weekly = parse_cron_expression("0 3 * * 1").unwrap();
        assert_eq!(
            due_cron_fire(&weekly, utc("2026-06-08T03:00:00Z"), utc("2026-06-10T12:00:00Z")),
            None
        );
        assert_eq!(
            due_cron_fire(&weekly, utc("2026-06-08T03:00:00Z"), utc("2026-06-15T03:00:30Z")),
            Some(utc("2026-06-15T03:00:00Z"))
        );
    }
}
