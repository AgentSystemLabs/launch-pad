//! Health-probe loop + rollout deadline math. Mirrors `packages/agent/src/health.ts`
//! (`waitHealthy`) and the rollout ceiling computed in `reconcile.ts`.
//!
//! The HTTP probe itself (`probeHealth`, an async `fetch`) is injected so the loop
//! logic tests offline; the real `reqwest` probe is the Phase-6 seam.

use std::time::Duration;

use crate::types::HealthCheck;

/// Single HTTP probe against a replica's published host port (loopback). A 2xx is
/// healthy; any error / non-2xx is unhealthy. Mirrors `probeHealth`.
pub fn probe_health(host_port: i64, path: &str, timeout_ms: i64) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(timeout_ms.max(0) as u64))
        .build();
    agent
        .get(&format!("http://127.0.0.1:{host_port}{path}"))
        .call()
        .is_ok()
}

/// The health-wait ceiling a rollout grants a surged replica before aborting.
/// Mirrors `Math.max(30_000, (timeoutMs + intervalMs) * healthyThreshold * 8)`.
pub fn rollout_health_ceiling_ms(hc: &HealthCheck) -> i64 {
    30_000.max((hc.timeout_ms + hc.interval_ms) * hc.healthy_threshold * 8)
}

/// Poll a replica until it passes `healthyThreshold` consecutive probes, or the ceiling
/// elapses. `probe`, `now` (ms), and `sleep` are injected (the agent supplies the real
/// HTTP probe + clock in Phase 6).
pub fn wait_healthy(
    hc: &HealthCheck,
    ceiling_ms: i64,
    mut probe: impl FnMut() -> bool,
    mut now: impl FnMut() -> i64,
    mut sleep: impl FnMut(i64),
) -> bool {
    let deadline = now() + ceiling_ms;
    let mut consecutive = 0;
    loop {
        if probe() {
            consecutive += 1;
            if consecutive >= hc.healthy_threshold {
                return true;
            }
        } else {
            consecutive = 0;
        }
        if now() >= deadline {
            return false;
        }
        sleep(hc.interval_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    fn hc(healthy_threshold: i64) -> HealthCheck {
        HealthCheck {
            path: "/healthz".into(),
            port: None,
            interval_ms: 2000,
            timeout_ms: 2000,
            healthy_threshold,
        }
    }

    /// A probe closure replaying a fixed result sequence (then `false` forever).
    fn probe_seq(results: Vec<bool>) -> impl FnMut() -> bool {
        let i = Rc::new(Cell::new(0usize));
        move || {
            let n = i.get();
            i.set(n + 1);
            results.get(n).copied().unwrap_or(false)
        }
    }

    /// A monotonic-ish clock replaying a fixed time sequence (then holding the last).
    fn clock(times: Vec<i64>) -> impl FnMut() -> i64 {
        let i = Rc::new(Cell::new(0usize));
        move || {
            let n = i.get();
            i.set(n + 1);
            *times.get(n).unwrap_or_else(|| times.last().unwrap())
        }
    }

    #[test]
    fn rollout_ceiling_uses_the_30s_floor_or_the_scaled_window() {
        // (2000 + 2000) * 2 * 8 = 64000 → above the 30s floor.
        assert_eq!(rollout_health_ceiling_ms(&hc(2)), 64_000);
        // A tiny check still gets the 30s floor: (1+1)*1*8 = 16 → 30000.
        let tiny = HealthCheck {
            path: "/h".into(),
            port: None,
            interval_ms: 1,
            timeout_ms: 1,
            healthy_threshold: 1,
        };
        assert_eq!(rollout_health_ceiling_ms(&tiny), 30_000);
    }

    #[test]
    fn returns_true_after_threshold_consecutive_successes() {
        let ok = wait_healthy(
            &hc(2),
            60_000,
            probe_seq(vec![true, true]),
            clock(vec![0, 100, 200]),
            |_| {},
        );
        assert!(ok);
    }

    #[test]
    fn resets_consecutive_count_on_a_failed_probe() {
        // true, false (reset), true, true → healthy only on the final pair.
        let ok = wait_healthy(
            &hc(2),
            60_000,
            probe_seq(vec![true, false, true, true]),
            clock(vec![0, 100, 200, 300, 400]),
            |_| {},
        );
        assert!(ok);
    }

    #[test]
    fn returns_false_when_the_deadline_elapses() {
        // Never healthy; clock jumps past the 1000ms ceiling on the second now() in-loop.
        let ok = wait_healthy(
            &hc(2),
            1_000,
            probe_seq(vec![false, false, false]),
            clock(vec![0, 500, 1_500]),
            |_| {},
        );
        assert!(!ok);
    }
}
