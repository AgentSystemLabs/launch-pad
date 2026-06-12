//! Shared poll-loop scaffolding for the edge/app binaries: clock, env parsing,
//! signal handling, and the run loop. Mirrors the harness half of
//! `packages/agent/src/index.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::SecondsFormat;

use crate::config::AgentConfig;
use crate::status_write::{resolve_liveness, ResolvedLiveness};
use crate::types::{NodeRole, DEFAULT_POLL_INTERVAL_MS, HEARTBEAT_STALE_MS, LIVENESS_HEARTBEAT_MS};

/// ISO8601 with milliseconds + `Z`, matching JS `Date#toISOString`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// The env-derived runtime settings both binaries share.
pub struct AgentEnv {
    pub agent_version: String,
    pub interval_ms: i64,
    pub once: bool,
    pub debug_s3: bool,
    pub liveness: ResolvedLiveness,
}

pub fn load_agent_env() -> AgentEnv {
    let interval_ms = env_i64("LAUNCHPAD_POLL_MS", DEFAULT_POLL_INTERVAL_MS);
    AgentEnv {
        agent_version: std::env::var("LAUNCHPAD_AGENT_VERSION").unwrap_or_else(|_| "0.0.0".into()),
        interval_ms,
        once: std::env::var("LAUNCHPAD_ONCE").as_deref() == Ok("1"),
        debug_s3: std::env::var("LAUNCHPAD_DEBUG_S3").as_deref() == Ok("1"),
        liveness: resolve_liveness(
            env_i64("LAUNCHPAD_LIVENESS_MS", LIVENESS_HEARTBEAT_MS) as f64,
            interval_ms,
            HEARTBEAT_STALE_MS,
        ),
    }
}

/// Fail closed when the binary's compiled role doesn't match the node's configured
/// role — the WRONG binary on a node would silently do nothing (an app binary on an
/// edge has no Caddy paths; an edge binary on an app node would never run containers).
pub fn assert_role(config: &AgentConfig, expected: NodeRole, binary: &str) {
    if config.role == expected {
        return;
    }
    let hint = match config.role {
        NodeRole::App => "this node is role=app — install the app agent binary (launchpad-agent-app)",
        NodeRole::Edge => {
            "this node is role=edge — install the edge agent binary (launchpad-agent-edge)"
        }
        NodeRole::Both => {
            "role 'both' was removed in protocol v2 — re-provision this node (or run `launchpad node upgrade-agent`)"
        }
    };
    eprintln!(
        "[agent] fatal: {binary} refuses to run for node {} with role={} in {}. {hint}",
        config.node_id,
        config.role.as_str(),
        std::env::var("LAUNCHPAD_AGENT_CONFIG").unwrap_or_else(|_| "/etc/launch-pad/agent.json".into()),
    );
    std::process::exit(1);
}

/// Install SIGTERM/SIGINT handlers and return the shared stop flag.
pub fn install_term_flag() -> Arc<AtomicBool> {
    let term = Arc::new(AtomicBool::new(false));
    let _ = signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&term));
    let _ = signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&term));
    term
}

/// The poll loop: one tick immediately, then tick every `interval_ms` until signaled.
pub fn run_poll_loop(interval_ms: i64, once: bool, term: &AtomicBool, mut tick: impl FnMut()) {
    tick();
    if once {
        return;
    }
    while !term.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(interval_ms.max(0) as u64));
        if term.load(Ordering::Relaxed) {
            break;
        }
        tick();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_iso_matches_js_to_iso_string_shape() {
        let iso = now_iso();
        // e.g. 2026-06-12T01:23:45.678Z
        assert!(iso.ends_with('Z'));
        assert_eq!(iso.len(), 24);
        assert_eq!(&iso[10..11], "T");
        assert_eq!(&iso[19..20], ".");
    }
}
