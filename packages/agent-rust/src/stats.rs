//! Resource-usage telemetry sampler. Mirrors `packages/agent/src/stats.ts`
//! (and the shared stats-line contract in `packages/shared/src/stats.ts`).
//!
//! Pure parsers + math up top; the impure sampler below takes its I/O through a
//! `StatsDeps` trait so the whole module tests offline. (Production async I/O wrapping
//! is deferred to Phase 4/6 — the spike's sampler is synchronous.)

use std::collections::BTreeMap;

use serde::Serialize;

use crate::docker::ManagedReplica;
use crate::types::service_key;

/// The discriminator that marks a stats line (and the CloudWatch filter term).
pub const STATS_EVENT: &str = "launchpad.stats";

/// Default sampling cadence; override with `LAUNCHPAD_STATS_INTERVAL_MS`.
pub const STATS_DEFAULT_INTERVAL_MS: i64 = 60_000;

// ── pure parsing / math ───────────────────────────────────────────────────────────

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

// Mirrors the TS `Math.max(0, Math.min(100, round1(n)))`. Kept as max/min (not
// `.clamp`) so the NaN edge matches JS exactly (`NaN.max(0.0)` → 0.0, vs clamp → NaN).
#[allow(clippy::manual_clamp)]
fn clamp_percent(n: f64) -> f64 {
    round1(n).max(0.0).min(100.0)
}

/// JS `Number.parseFloat`: parse the longest leading numeric prefix, else NaN.
fn js_parse_float(s: &str) -> f64 {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut seen_digit = false;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        seen_digit = true;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            seen_digit = true;
        }
    }
    if seen_digit && i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let mut exp_digit = false;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
            exp_digit = true;
        }
        if exp_digit {
            i = j;
        }
    }
    if !seen_digit {
        return f64::NAN;
    }
    s[..i].parse::<f64>().unwrap_or(f64::NAN)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CpuTimes {
    /// Sum of all jiffy fields on the aggregate `cpu` line.
    pub total: f64,
    /// Idle + iowait jiffies.
    pub idle: f64,
}

/// Parse the aggregate `cpu` line of /proc/stat into total + idle jiffies.
pub fn parse_cpu_stat(proc_stat: &str) -> Option<CpuTimes> {
    for line in proc_stat.split('\n') {
        if !line.starts_with("cpu ") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().skip(1).collect();
        if fields.len() < 5 {
            return None;
        }
        let mut nums = Vec::with_capacity(fields.len());
        for f in &fields {
            match f.parse::<f64>() {
                Ok(n) => nums.push(n),
                Err(_) => return None,
            }
        }
        let total: f64 = nums.iter().sum();
        let idle = nums.get(3).copied().unwrap_or(0.0) + nums.get(4).copied().unwrap_or(0.0);
        return Some(CpuTimes { total, idle });
    }
    None
}

/// Host CPU busy % over the interval between two /proc/stat readings.
pub fn cpu_percent_from_delta(prev: CpuTimes, cur: CpuTimes) -> f64 {
    let dt = cur.total - prev.total;
    let di = cur.idle - prev.idle;
    if dt <= 0.0 {
        return 0.0;
    }
    clamp_percent((1.0 - di / dt) * 100.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    pub memory_used_mb: i64,
    pub memory_total_mb: i64,
}

/// Parse /proc/meminfo into used + total MB (used = MemTotal − MemAvailable).
/// Mirrors the TS regex `^(\w+):\s+(\d+)\s*kB`.
pub fn parse_mem_info(meminfo: &str) -> Option<MemInfo> {
    let mut total_kb: Option<f64> = None;
    let mut avail_kb: Option<f64> = None;
    for line in meminfo.split('\n') {
        let Some(colon) = line.find(':') else { continue };
        let key = &line[..colon];
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            continue;
        }
        let rest = &line[colon + 1..];
        let after_ws = rest.trim_start();
        if after_ws.len() == rest.len() {
            continue; // `\s+` requires at least one whitespace after the colon
        }
        let digits: String = after_ws.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        if !after_ws[digits.len()..].trim_start().starts_with("kB") {
            continue;
        }
        let Ok(val) = digits.parse::<f64>() else { continue };
        match key {
            "MemTotal" => total_kb = Some(val),
            "MemAvailable" => avail_kb = Some(val),
            _ => {}
        }
    }
    let (Some(total), Some(avail)) = (total_kb, avail_kb) else {
        return None;
    };
    let used = (total - avail).max(0.0);
    Some(MemInfo {
        memory_used_mb: (used / 1024.0).round() as i64,
        memory_total_mb: (total / 1024.0).round() as i64,
    })
}

/// Parse a `docker stats` CPU percent string like `"12.34%"` into a number.
pub fn parse_percent(s: &str) -> f64 {
    let cleaned = s.replacen('%', "", 1);
    let n = js_parse_float(cleaned.trim());
    if n.is_finite() {
        n
    } else {
        0.0
    }
}

fn unit_to_mb(unit: &str) -> f64 {
    match unit {
        "B" => 1.0 / (1024.0 * 1024.0),
        "KIB" | "KB" => 1.0 / 1024.0,
        "MIB" | "MB" => 1.0,
        "GIB" | "GB" => 1024.0,
        "TIB" | "TB" => 1024.0 * 1024.0,
        _ => 0.0,
    }
}

/// Parse a docker size like `"10.5MiB"` / `"1.2GiB"` into whole MB.
/// Mirrors the TS regex `^([\d.]+)\s*([A-Za-z]+)$`.
pub fn parse_size_to_mb(s: &str) -> i64 {
    let t = s.trim();
    let num_end = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(t.len());
    let num_str = &t[..num_end];
    let rest = t[num_end..].trim_start();
    if num_str.is_empty() || rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_alphabetic()) {
        return 0;
    }
    let value = js_parse_float(num_str);
    if !value.is_finite() {
        return 0;
    }
    let factor = unit_to_mb(&rest.to_ascii_uppercase());
    (value * factor).round() as i64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemUsage {
    pub used_mb: i64,
    pub limit_mb: i64,
}

/// Parse a docker `MemUsage` cell like `"10.5MiB / 256MiB"` into used + limit MB.
pub fn parse_mem_usage(s: &str) -> MemUsage {
    let mut parts = s.split('/');
    let used = parts.next().unwrap_or("0");
    let limit = parts.next().unwrap_or("0");
    MemUsage {
        used_mb: parse_size_to_mb(used),
        limit_mb: parse_size_to_mb(limit),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DockerStatRow {
    pub id: String,
    pub cpu_percent_raw: f64,
    pub memory_used_mb: i64,
    pub memory_limit_mb: i64,
}

#[derive(serde::Deserialize)]
struct RawStat {
    #[serde(rename = "ID")]
    id: Option<String>,
    #[serde(rename = "Container")]
    container: Option<String>,
    #[serde(rename = "CPUPerc")]
    cpu_perc: Option<String>,
    #[serde(rename = "MemUsage")]
    mem_usage: Option<String>,
}

/// Parse `docker stats --no-stream --format '{{json .}}'` output (one JSON object/line).
pub fn parse_docker_stats(stdout: &str) -> Vec<DockerStatRow> {
    let mut rows = Vec::new();
    for line in stdout.split('\n') {
        let t = line.trim();
        if !t.starts_with('{') {
            continue;
        }
        let Ok(o) = serde_json::from_str::<RawStat>(t) else {
            continue;
        };
        let id = o.id.or(o.container).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let mem = parse_mem_usage(o.mem_usage.as_deref().unwrap_or(""));
        rows.push(DockerStatRow {
            id,
            cpu_percent_raw: parse_percent(o.cpu_perc.as_deref().unwrap_or("0%")),
            memory_used_mb: mem.used_mb,
            memory_limit_mb: mem.limit_mb,
        });
    }
    rows
}

/// Normalize raw `docker stats` CPU (% of one core) to % of the cgroup's `--cpus` limit.
pub fn cpu_percent_of_limit(raw_percent: f64, cpu_shares: i64) -> f64 {
    let cpus = cpu_shares as f64 / 1024.0;
    clamp_percent(if cpus > 0.0 {
        raw_percent / cpus
    } else {
        raw_percent
    })
}

/// docker stats `.ID` is a short id; inspect ids are full — match by either prefix.
fn same_container(full_id: &str, stat_id: &str) -> bool {
    full_id.starts_with(stat_id) || stat_id.starts_with(full_id)
}

/// One managed replica's utilization at sample time (shared `ServiceStats`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStats {
    pub project: String,
    pub service: String,
    pub replica: i64,
    pub cpu_percent: f64,
    pub memory_used_mb: i64,
    pub memory_limit_mb: i64,
}

/// Whole-host utilization at sample time (shared `HostStats`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub cpu_percent: f64,
    pub memory_used_mb: i64,
    pub memory_total_mb: i64,
}

/// One sampled line emitted by the agent (shared `StatsLine`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsLine {
    pub event: String,
    pub node_id: String,
    pub ts: String,
    pub host: HostStats,
    pub services: Vec<ServiceStats>,
}

/// Pure join: one `ServiceStats` per running managed replica, normalizing CPU to the
/// replica's desired `--cpus` limit. Missing docker rows fall back to zero.
pub fn assemble_service_stats(
    replicas: &[ManagedReplica],
    docker_rows: &[DockerStatRow],
    cpu_shares_by_key: &BTreeMap<String, i64>,
) -> Vec<ServiceStats> {
    replicas
        .iter()
        .filter(|r| r.state == "running")
        .map(|r| {
            let row = docker_rows.iter().find(|d| same_container(&r.id, &d.id));
            let shares = cpu_shares_by_key
                .get(&service_key(&r.project, &r.service))
                .copied()
                .unwrap_or(0);
            ServiceStats {
                project: r.project.clone(),
                service: r.service.clone(),
                replica: r.index,
                cpu_percent: row
                    .map(|d| cpu_percent_of_limit(d.cpu_percent_raw, shares))
                    .unwrap_or(0.0),
                memory_used_mb: row.map(|d| d.memory_used_mb).unwrap_or(0),
                memory_limit_mb: row.map(|d| d.memory_limit_mb).unwrap_or(0),
            }
        })
        .collect()
}

/// A service's `cpu` shares keyed input for `cpu_shares_by_key`.
pub struct SvcCpu {
    pub project: String,
    pub service: String,
    pub cpu: i64,
}

/// Build the `serviceKey → cpu shares` map used to normalize per-replica CPU.
pub fn cpu_shares_by_key(services: &[SvcCpu]) -> BTreeMap<String, i64> {
    services
        .iter()
        .map(|s| (service_key(&s.project, &s.service), s.cpu))
        .collect()
}

pub fn build_stats_line(
    node_id: &str,
    ts: String,
    host: HostStats,
    services: Vec<ServiceStats>,
) -> StatsLine {
    StatsLine {
        event: STATS_EVENT.to_string(),
        node_id: node_id.to_string(),
        ts,
        host,
        services,
    }
}

/// Serialize to the single-line JSON the agent writes to stderr.
pub fn serialize_stats_line(line: &StatsLine) -> String {
    serde_json::to_string(line).expect("StatsLine is always serializable")
}

// ── sampling (impure, injectable) ───────────────────────────────────────────────────

/// I/O the sampler needs, injected so the module tests offline. Synchronous for the spike.
pub trait StatsDeps {
    fn read(&self, path: &str) -> Result<String, String>;
    fn sleep_ms(&self, ms: i64);
    fn docker_stats(&self, ids: &[String]) -> Result<String, String>;
    fn inspect(&self) -> Result<Vec<ManagedReplica>, String>;
    fn now(&self) -> String;
}

/// How long to hold between the two /proc/stat reads that yield a CPU delta.
const CPU_SAMPLE_WINDOW_MS: i64 = 250;

fn sample_host<D: StatsDeps>(deps: &D) -> Result<HostStats, String> {
    let a = parse_cpu_stat(&deps.read("/proc/stat")?);
    deps.sleep_ms(CPU_SAMPLE_WINDOW_MS);
    let b = parse_cpu_stat(&deps.read("/proc/stat")?);
    let cpu_percent = match (a, b) {
        (Some(a), Some(b)) => cpu_percent_from_delta(a, b),
        _ => 0.0,
    };
    let mem = parse_mem_info(&deps.read("/proc/meminfo")?);
    Ok(HostStats {
        cpu_percent,
        memory_used_mb: mem.map(|m| m.memory_used_mb).unwrap_or(0),
        memory_total_mb: mem.map(|m| m.memory_total_mb).unwrap_or(0),
    })
}

pub struct StatsSampler<D: StatsDeps> {
    node_id: String,
    interval_ms: i64,
    include_services: bool,
    deps: D,
    emit: Box<dyn FnMut(&str)>,
    warn: Box<dyn FnMut(&str)>,
    last_emit: Option<i64>,
    last_host: Option<crate::types::HostSample>,
    warned: bool,
}

impl<D: StatsDeps> StatsSampler<D> {
    pub fn new<E, W>(
        node_id: impl Into<String>,
        interval_ms: i64,
        include_services: bool,
        deps: D,
        emit: E,
        warn: W,
    ) -> Self
    where
        E: FnMut(&str) + 'static,
        W: FnMut(&str) + 'static,
    {
        Self {
            node_id: node_id.into(),
            interval_ms,
            include_services,
            deps,
            emit: Box::new(emit),
            warn: Box::new(warn),
            last_emit: None,
            last_host: None,
            warned: false,
        }
    }

    /// The most recent successful host sample (embedded into status.json so the CLI's
    /// `autoscale run` can read live utilization), or None before the first sample.
    /// Mirrors the TS `latestHost()`.
    pub fn latest_host(&self) -> Option<crate::types::HostSample> {
        self.last_host.clone()
    }

    fn warn_once(&mut self, message: &str) {
        if self.warned {
            return;
        }
        self.warned = true;
        (self.warn)(&format!("sampling failed (continuing): {message}"));
    }

    /// Best-effort per-service sampling; docker failures degrade to `[]`, never error.
    fn sample_services(&mut self, cpu_shares_by_key: &BTreeMap<String, i64>) -> Vec<ServiceStats> {
        let inspected = match self.deps.inspect() {
            Ok(v) => v,
            Err(e) => {
                self.warn_once(&e);
                return Vec::new();
            }
        };
        let running: Vec<ManagedReplica> = inspected
            .into_iter()
            .filter(|r| !r.id.is_empty() && r.state == "running")
            .collect();
        if running.is_empty() {
            return Vec::new();
        }
        let ids: Vec<String> = running.iter().map(|r| r.id.clone()).collect();
        let out = match self.deps.docker_stats(&ids) {
            Ok(s) => s,
            Err(e) => {
                self.warn_once(&e);
                return Vec::new();
            }
        };
        let rows = parse_docker_stats(&out);
        assemble_service_stats(&running, &rows, cpu_shares_by_key)
    }

    /// Build (but do not emit) one stats line.
    pub fn sample_once(
        &mut self,
        cpu_shares_by_key: &BTreeMap<String, i64>,
    ) -> Result<StatsLine, String> {
        let host = sample_host(&self.deps)?;
        let services = if self.include_services {
            self.sample_services(cpu_shares_by_key)
        } else {
            Vec::new()
        };
        let ts = self.deps.now();
        self.last_host = Some(crate::types::HostSample {
            cpu_percent: host.cpu_percent,
            memory_used_mb: host.memory_used_mb as f64,
            memory_total_mb: host.memory_total_mb as f64,
            sampled_at: ts.clone(),
        });
        Ok(build_stats_line(&self.node_id, ts, host, services))
    }

    /// Emit one stats line if at least `interval_ms` has elapsed since the last emit.
    /// Degraded-safe; a non-positive interval disables sampling entirely.
    pub fn maybe_sample(&mut self, at: i64, cpu_shares_by_key: &BTreeMap<String, i64>) {
        if self.interval_ms <= 0 {
            return;
        }
        if let Some(last) = self.last_emit {
            if at - last < self.interval_ms {
                return;
            }
        }
        self.last_emit = Some(at); // gate before sampling so a slow/failed sample still backs off
        match self.sample_once(cpu_shares_by_key) {
            Ok(line) => {
                let s = serialize_stats_line(&line);
                (self.emit)(&s);
                self.warned = false;
            }
            Err(e) => self.warn_once(&e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::ManagedReplica;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    fn replica() -> ManagedReplica {
        ManagedReplica {
            id: "fullid000000000000000000000000000000000000000000000000000000abc1".into(),
            name: "launchpad_blog_api_0".into(),
            index: 0,
            state: "running".into(),
            project: "blog".into(),
            service: "api".into(),
            image: "img".into(),
            cpu: 256,
            memory: 256,
            host_port: None,
            config_stamp: String::new(),
            cron_fire_ms: None,
            job_run_id: None,
            exit_code: None,
        }
    }

    // ── parseCpuStat ──
    #[test]
    fn sums_all_jiffy_fields_and_takes_idle_plus_iowait() {
        let stat = parse_cpu_stat("cpu  100 0 50 800 30 0 20 0\ncpu0 ...");
        assert_eq!(
            stat,
            Some(CpuTimes {
                total: 100.0 + 0.0 + 50.0 + 800.0 + 30.0 + 0.0 + 20.0 + 0.0,
                idle: 800.0 + 30.0,
            })
        );
    }

    #[test]
    fn returns_null_without_an_aggregate_cpu_line() {
        assert_eq!(parse_cpu_stat("intr 1 2 3\nctxt 99"), None);
    }

    // ── cpuPercentFromDelta ──
    #[test]
    fn computes_busy_fraction_over_the_interval() {
        assert_eq!(
            cpu_percent_from_delta(
                CpuTimes { total: 0.0, idle: 0.0 },
                CpuTimes { total: 1000.0, idle: 750.0 }
            ),
            25.0
        );
    }

    #[test]
    fn is_zero_when_no_time_elapsed() {
        assert_eq!(
            cpu_percent_from_delta(
                CpuTimes { total: 10.0, idle: 5.0 },
                CpuTimes { total: 10.0, idle: 5.0 }
            ),
            0.0
        );
    }

    // ── parseMemInfo ──
    #[test]
    fn derives_used_equals_total_minus_available_in_mb() {
        let info =
            parse_mem_info("MemTotal:       2048000 kB\nMemFree: 100 kB\nMemAvailable:   1024000 kB\n");
        assert_eq!(
            info,
            Some(MemInfo {
                memory_used_mb: 1000,
                memory_total_mb: 2000
            })
        );
    }

    #[test]
    fn returns_null_when_memavailable_is_absent() {
        assert_eq!(parse_mem_info("MemTotal: 2048000 kB"), None);
    }

    // ── parseSizeToMb / parseMemUsage / parsePercent ──
    #[test]
    fn parses_docker_size_units() {
        assert_eq!(parse_size_to_mb("256MiB"), 256);
        assert_eq!(parse_size_to_mb("1.5GiB"), 1536);
        assert_eq!(parse_size_to_mb("512KiB"), 1); // rounds to nearest MB
    }

    #[test]
    fn splits_a_memusage_cell_into_used_plus_limit() {
        assert_eq!(
            parse_mem_usage("10.5MiB / 256MiB"),
            MemUsage {
                used_mb: 11,
                limit_mb: 256
            }
        );
    }

    #[test]
    fn parses_a_cpu_percent_cell() {
        assert!((parse_percent("12.34%") - 12.34).abs() < 1e-9);
        assert_eq!(parse_percent("--"), 0.0);
    }

    // ── parseDockerStats ──
    #[test]
    fn parses_one_json_object_per_line_skipping_noise() {
        let out = [
            r#"{"ID":"abc123","Name":"launchpad_blog_api_0","CPUPerc":"50.00%","MemUsage":"128MiB / 256MiB"}"#,
            "",
            "warning: some stderr leaked in",
            r#"{"ID":"def456","CPUPerc":"5.00%","MemUsage":"20MiB / 512MiB"}"#,
        ]
        .join("\n");
        assert_eq!(
            parse_docker_stats(&out),
            vec![
                DockerStatRow {
                    id: "abc123".into(),
                    cpu_percent_raw: 50.0,
                    memory_used_mb: 128,
                    memory_limit_mb: 256
                },
                DockerStatRow {
                    id: "def456".into(),
                    cpu_percent_raw: 5.0,
                    memory_used_mb: 20,
                    memory_limit_mb: 512
                },
            ]
        );
    }

    // ── cpuPercentOfLimit ──
    #[test]
    fn normalizes_raw_docker_cpu_to_percent_of_limit() {
        assert_eq!(cpu_percent_of_limit(50.0, 512), 100.0);
        assert_eq!(cpu_percent_of_limit(50.0, 1024), 50.0);
    }

    #[test]
    fn returns_the_raw_percent_when_no_limit_is_known() {
        assert_eq!(cpu_percent_of_limit(42.0, 0), 42.0);
    }

    // ── assembleServiceStats ──
    #[test]
    fn joins_replicas_to_docker_rows_by_id_prefix_and_normalizes_cpu_to_limit() {
        let replicas = [replica()];
        let rows = [DockerStatRow {
            id: "fullid000000".into(),
            cpu_percent_raw: 50.0,
            memory_used_mb: 100,
            memory_limit_mb: 256,
        }];
        let shares = cpu_shares_by_key(&[SvcCpu {
            project: "blog".into(),
            service: "api".into(),
            cpu: 512,
        }]);
        assert_eq!(
            assemble_service_stats(&replicas, &rows, &shares),
            vec![ServiceStats {
                project: "blog".into(),
                service: "api".into(),
                replica: 0,
                cpu_percent: 100.0,
                memory_used_mb: 100,
                memory_limit_mb: 256,
            }]
        );
    }

    #[test]
    fn skips_non_running_replicas_and_zero_fills_when_no_docker_row_matches() {
        let replicas = [
            ManagedReplica {
                index: 0,
                state: "exited".into(),
                ..replica()
            },
            ManagedReplica {
                index: 1,
                name: "launchpad_blog_api_1".into(),
                id: "unmatchedid111111111111".into(),
                ..replica()
            },
        ];
        let stats = assemble_service_stats(&replicas, &[], &BTreeMap::new());
        assert_eq!(
            stats,
            vec![ServiceStats {
                project: "blog".into(),
                service: "api".into(),
                replica: 1,
                cpu_percent: 0.0,
                memory_used_mb: 0,
                memory_limit_mb: 0,
            }]
        );
    }

    // ── createStatsSampler ──
    struct TestDeps {
        proc_stat: String,
        proc_stat2: String,
        meminfo: String,
        reads: Cell<u32>,
        docker_stats: Box<dyn Fn() -> Result<String, String>>,
        inspect: Box<dyn Fn() -> Result<Vec<ManagedReplica>, String>>,
        now: String,
    }

    impl TestDeps {
        fn new() -> Self {
            TestDeps {
                proc_stat: "cpu  100 0 50 800 30 0 20 0\n".into(),
                proc_stat2: "cpu  200 0 100 1400 60 0 40 0\n".into(),
                meminfo: "MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n".into(),
                reads: Cell::new(0),
                docker_stats: Box::new(|| Ok(String::new())),
                inspect: Box::new(|| Ok(Vec::new())),
                now: "2026-06-04T00:00:00Z".into(),
            }
        }
    }

    impl StatsDeps for TestDeps {
        fn read(&self, path: &str) -> Result<String, String> {
            if path == "/proc/meminfo" {
                return Ok(self.meminfo.clone());
            }
            let n = self.reads.get() + 1;
            self.reads.set(n);
            Ok(if n <= 1 {
                self.proc_stat.clone()
            } else {
                self.proc_stat2.clone()
            })
        }
        fn sleep_ms(&self, _ms: i64) {}
        fn docker_stats(&self, _ids: &[String]) -> Result<String, String> {
            (self.docker_stats)()
        }
        fn inspect(&self) -> Result<Vec<ManagedReplica>, String> {
            (self.inspect)()
        }
        fn now(&self) -> String {
            self.now.clone()
        }
    }

    #[test]
    fn emits_exactly_one_line_then_suppresses_until_the_interval_elapses() {
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let mut sampler = StatsSampler::new(
            "node-1",
            60_000,
            true,
            TestDeps::new(),
            move |s: &str| l2.borrow_mut().push(s.to_string()),
            |_s: &str| {},
        );
        sampler.maybe_sample(0, &BTreeMap::new());
        sampler.maybe_sample(30_000, &BTreeMap::new()); // within interval → skipped
        assert_eq!(lines.borrow().len(), 1);
        sampler.maybe_sample(60_000, &BTreeMap::new()); // interval elapsed → emits
        assert_eq!(lines.borrow().len(), 2);

        let parsed: serde_json::Value = serde_json::from_str(&lines.borrow()[0]).unwrap();
        assert_eq!(parsed["event"], "launchpad.stats");
        // delta total = 800, delta idle = 630 → busy = (1 − 630/800)·100 = 21.25 → 21.3
        assert_eq!(parsed["host"]["cpuPercent"].as_f64().unwrap(), 21.3);
        assert_eq!(parsed["host"]["memoryUsedMb"].as_i64().unwrap(), 1000);
    }

    #[test]
    fn is_disabled_by_a_non_positive_interval() {
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let mut sampler = StatsSampler::new(
            "node-1",
            0,
            true,
            TestDeps::new(),
            move |s: &str| l2.borrow_mut().push(s.to_string()),
            |_s: &str| {},
        );
        sampler.maybe_sample(0, &BTreeMap::new());
        assert_eq!(lines.borrow().len(), 0);
    }

    #[test]
    fn still_emits_host_stats_when_docker_sampling_throws() {
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let warnings = Rc::new(RefCell::new(Vec::<String>::new()));
        let l2 = lines.clone();
        let w2 = warnings.clone();
        let mut deps = TestDeps::new();
        deps.inspect = Box::new(|| Ok(vec![replica()]));
        deps.docker_stats = Box::new(|| Err("docker not running".to_string()));
        let mut sampler = StatsSampler::new(
            "node-1",
            60_000,
            true,
            deps,
            move |s: &str| l2.borrow_mut().push(s.to_string()),
            move |s: &str| w2.borrow_mut().push(s.to_string()),
        );
        sampler.maybe_sample(0, &BTreeMap::new());
        assert_eq!(lines.borrow().len(), 1);
        let parsed: serde_json::Value = serde_json::from_str(&lines.borrow()[0]).unwrap();
        assert_eq!(parsed["host"]["memoryTotalMb"].as_i64().unwrap(), 2000);
        assert_eq!(parsed["services"].as_array().unwrap().len(), 0);
        assert!(warnings.borrow().join("").contains("docker not running"));
    }
}
