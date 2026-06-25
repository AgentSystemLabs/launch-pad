//! Pure helpers for the managed-database backup sidecar (app role only).
//!
//! A managed database service is an ordinary long-running worker (the postgres
//! container) that ALSO carries a `backup` config. On the backup schedule the agent
//! dumps each logical database with `pg_dump | gzip` and uploads
//! `<prefix><database>/<timestamp>.sql.gz` to the backups bucket, then prunes dumps
//! older than `retentionDays`. This module is the TESTED SEAM — the timestamp
//! format, S3 key building, prune selection, and target selection are pure so the
//! docker/S3 I/O (in `reconcile.rs`/`s3_backup.rs`) stays thin.
//!
//! The object timestamp is colon-free (`YYYY-MM-DDTHH-MM-SSZ`) so it is a safe S3
//! key segment, and `parse_backup_timestamp` is its exact inverse for pruning.

use chrono::{DateTime, NaiveDateTime, Utc};

/// State-key prefix the backup schedule uses inside `LocalState.cron_fires`, kept
/// separate from a same-named cron service's anchor: `backup:<project>/<service>`.
pub const BACKUP_STATE_KEY_PREFIX: &str = "backup:";

/// The local fire-anchor key for a service's backup schedule. Namespaced under
/// [`BACKUP_STATE_KEY_PREFIX`] so it never collides with a cron service's anchor.
pub fn backup_state_key(service_key: &str) -> String {
    format!("{BACKUP_STATE_KEY_PREFIX}{service_key}")
}

const MS_PER_DAY: i64 = 86_400_000;
/// `YYYY-MM-DDTHH-MM-SSZ` — UTC, second precision, colon-free (safe S3 key segment).
const TS_FORMAT: &str = "%Y-%m-%dT%H-%M-%SZ";

/// Format an epoch-ms instant as the colon-free backup object timestamp
/// (`2026-06-25T03-00-00Z`). Truncates to second precision in UTC.
pub fn backup_timestamp(now_ms: i64) -> String {
    // from_timestamp_millis is infallible across the representable range we care
    // about; fall back to the epoch on the impossible None so this stays total.
    let dt: DateTime<Utc> =
        DateTime::from_timestamp_millis(now_ms).unwrap_or_else(|| DateTime::from_timestamp_millis(0).expect("epoch is valid"));
    dt.format(TS_FORMAT).to_string()
}

/// Inverse of [`backup_timestamp`]: parse the timestamp out of an object name or full
/// S3 key (only the trailing `<timestamp>.sql.gz` segment is read) back to epoch ms.
/// Returns None when the segment is not a well-formed backup timestamp.
pub fn parse_backup_timestamp(object_name_or_key: &str) -> Option<i64> {
    // Take just the final path segment, then strip the `.sql.gz` suffix.
    let name = object_name_or_key
        .rsplit('/')
        .next()
        .unwrap_or(object_name_or_key);
    let stamp = name.strip_suffix(".sql.gz").unwrap_or(name);
    let naive = NaiveDateTime::parse_from_str(stamp, TS_FORMAT).ok()?;
    Some(naive.and_utc().timestamp_millis())
}

/// The S3 object key for one database dump: `{prefix}{database}/{timestamp}.sql.gz`.
/// `prefix` already ends in `/` (`<cluster>/<owner>/<service>/`).
pub fn backup_object_key(prefix: &str, database: &str, timestamp: &str) -> String {
    format!("{prefix}{database}/{timestamp}.sql.gz")
}

/// Select the keys whose embedded timestamp is OLDER than the retention window
/// (`now_ms - retention_days * 86_400_000`). Keys without a parseable timestamp are
/// left untouched (never pruned — they are not ours / not a dated dump). A
/// `retention_days <= 0` is treated as "keep nothing dated before now" defensively,
/// but the CLI schema enforces `>= 1`.
pub fn select_expired_keys(keys: &[String], now_ms: i64, retention_days: i64) -> Vec<String> {
    let cutoff = now_ms - retention_days * MS_PER_DAY;
    keys.iter()
        .filter(|k| match parse_backup_timestamp(k) {
            Some(ts) => ts < cutoff,
            None => false,
        })
        .cloned()
        .collect()
}

/// The databases to back up: the EXPLICIT list when non-empty, otherwise the set
/// ENUMERATED from the running engine (every non-template, non-`postgres` database).
pub fn database_targets(explicit: &[String], enumerated: &[String]) -> Vec<String> {
    if explicit.is_empty() {
        enumerated.to_vec()
    } else {
        explicit.to_vec()
    }
}

/// True when `s` is a safe Postgres logical identifier (database name / role name),
/// mirroring the shared `LOGICAL_DB_NAME_REGEX` (`^[A-Za-z_][A-Za-z0-9_$]{0,62}$`):
/// the first char is a letter or underscore, the rest are letters/digits/underscore/`$`,
/// and the total length is 1..=63. This is BOTH a sanity filter on enumerated names and
/// a hard guard before a name is interpolated into an S3 object key — an un-validated
/// name (e.g. containing `/` or `..`) could escape the backup prefix. Pure + tested.
pub fn is_valid_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(iso: &str) -> i64 {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn backup_timestamp_is_colon_free_second_precision_utc() {
        // 2026-06-25T03:00:00Z → colon-free form.
        let ts = backup_timestamp(utc("2026-06-25T03:00:00Z"));
        assert_eq!(ts, "2026-06-25T03-00-00Z");
        // Sub-second component is truncated.
        let ts2 = backup_timestamp(utc("2026-06-25T03:00:00Z") + 750);
        assert_eq!(ts2, "2026-06-25T03-00-00Z");
    }

    #[test]
    fn timestamp_round_trips_through_parse() {
        let ms = utc("2026-06-25T03:00:00Z");
        let ts = backup_timestamp(ms);
        assert_eq!(parse_backup_timestamp(&ts), Some(ms));
    }

    #[test]
    fn parse_reads_the_timestamp_out_of_a_full_object_key() {
        let key = "default/owner/db/app/2026-06-25T03-00-00Z.sql.gz";
        assert_eq!(parse_backup_timestamp(key), Some(utc("2026-06-25T03:00:00Z")));
        // bare object name (no prefix, no suffix) also parses.
        assert_eq!(
            parse_backup_timestamp("2026-06-25T03-00-00Z"),
            Some(utc("2026-06-25T03:00:00Z"))
        );
    }

    #[test]
    fn parse_returns_none_for_a_non_timestamp_segment() {
        assert_eq!(parse_backup_timestamp("prefix/db/not-a-dump.txt"), None);
        assert_eq!(parse_backup_timestamp("prefix/db/README.sql.gz"), None);
        assert_eq!(parse_backup_timestamp(""), None);
    }

    #[test]
    fn backup_object_key_joins_prefix_database_and_timestamp() {
        assert_eq!(
            backup_object_key("default/owner/db/", "app", "2026-06-25T03-00-00Z"),
            "default/owner/db/app/2026-06-25T03-00-00Z.sql.gz"
        );
    }

    #[test]
    fn select_expired_prunes_only_keys_older_than_the_retention_window() {
        let now = utc("2026-06-25T03:00:00Z");
        // retention 7 days → cutoff is 2026-06-18T03:00:00Z.
        let keys = vec![
            // 8 days old → expired
            backup_object_key("p/", "app", &backup_timestamp(utc("2026-06-17T03:00:00Z"))),
            // exactly 7 days old → strictly < cutoff? same instant is NOT < cutoff → kept
            backup_object_key("p/", "app", &backup_timestamp(utc("2026-06-18T03:00:00Z"))),
            // 1 day old → kept
            backup_object_key("p/", "app", &backup_timestamp(utc("2026-06-24T03:00:00Z"))),
            // not a dated dump → never pruned
            "p/app/notes.txt".to_string(),
        ];
        let expired = select_expired_keys(&keys, now, 7);
        assert_eq!(expired.len(), 1);
        assert!(expired[0].contains("2026-06-17T03-00-00Z"));
    }

    #[test]
    fn select_expired_keeps_everything_when_nothing_is_old_enough() {
        let now = utc("2026-06-25T03:00:00Z");
        let keys = vec![backup_object_key(
            "p/",
            "app",
            &backup_timestamp(utc("2026-06-24T03:00:00Z")),
        )];
        assert!(select_expired_keys(&keys, now, 7).is_empty());
    }

    #[test]
    fn database_targets_prefers_explicit_then_falls_back_to_enumerated() {
        let explicit = vec!["a".to_string(), "b".to_string()];
        let enumerated = vec!["x".to_string(), "y".to_string()];
        assert_eq!(database_targets(&explicit, &enumerated), explicit);
        assert_eq!(database_targets(&[], &enumerated), enumerated);
        // both empty → empty (nothing to back up).
        assert!(database_targets(&[], &[]).is_empty());
    }

    #[test]
    fn backup_state_key_is_namespaced() {
        assert_eq!(backup_state_key("blog/db"), "backup:blog/db");
    }

    #[test]
    fn is_valid_identifier_accepts_postgres_names() {
        assert!(is_valid_identifier("app"));
        assert!(is_valid_identifier("App_1"));
        assert!(is_valid_identifier("a$b"));
        assert!(is_valid_identifier("_x"));
    }

    #[test]
    fn is_valid_identifier_rejects_unsafe_or_malformed_names() {
        assert!(!is_valid_identifier("a/b")); // prefix-escape character
        assert!(!is_valid_identifier("a..b")); // path traversal
        assert!(!is_valid_identifier("")); // empty
        assert!(!is_valid_identifier("1abc")); // must not start with a digit
        // 64 chars exceeds the 63-char limit.
        assert!(!is_valid_identifier(&"a".repeat(64)));
        // exactly 63 chars is still valid (boundary).
        assert!(is_valid_identifier(&"a".repeat(63)));
    }
}
