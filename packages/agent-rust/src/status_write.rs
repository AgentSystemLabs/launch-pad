//! Write-on-change fingerprints + liveness logic. Mirrors
//! `packages/agent/src/status-write.ts`.
//!
//! The fingerprint hashes a status/shard over its *meaningful* fields only (dropping
//! timestamp-only fields) so two idle ticks fingerprint identically. Cross-language
//! byte-parity with the TS hash is achieved by serializing through `serde_json::Value`
//! (whose default `Map` is a BTreeMap → keys come out sorted, reproducing the TS
//! `canonical()` recursive key-sort) and `Option::is_none` skips (reproducing
//! `JSON.stringify` omitting `undefined`).

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::types::{EdgeRouteStatus, NodeStatus, ReplicaStatus, ServiceState, ServiceStatus, UpstreamBackend, UpstreamShard};
use crate::types::service_key;

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Hash a payload the way TS does: `sha256(JSON.stringify(canonical(payload)))`.
/// Routing through `to_value` sorts every object's keys (BTreeMap-backed `Map`).
fn canonical_hash<T: Serialize>(payload: &T) -> String {
    let value = serde_json::to_value(payload).expect("payload is serializable");
    sha256_hex(&serde_json::to_string(&value).expect("Value is serializable"))
}

// ── fingerprintStatus ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FpReplica {
    index: i64,
    container_id: Option<String>,
    host_port: Option<i64>,
    state: ServiceState,
    image: String,
    healthy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FpService {
    project: String,
    service: String,
    image: String,
    state: ServiceState,
    message: String,
    container_id: Option<String>,
    desired_replicas: i64,
    running_replicas: i64,
    replicas: Vec<FpReplica>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FpCaddy {
    managed: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FpStatusPayload {
    node_id: String,
    agent_id: String,
    agent_version: String,
    caddy: FpCaddy,
    services: Vec<FpService>,
    edge_routes: Vec<EdgeRouteStatus>,
}

/// Hash a [`NodeStatus`] over its meaningful fields, dropping `lastSeen`, per-service
/// `updatedAt`, and `caddy.lastReloadAt`. Services/replicas/edge routes are sorted so
/// a different listing order can't perturb the result.
pub fn fingerprint_status(status: &NodeStatus) -> String {
    let mut services: Vec<&ServiceStatus> = status.services.iter().collect();
    services.sort_by(|a, b| {
        service_key(&a.project, &a.service).cmp(&service_key(&b.project, &b.service))
    });
    let fp_services: Vec<FpService> = services
        .iter()
        .map(|s| {
            let mut reps: Vec<&ReplicaStatus> = s.replicas.iter().collect();
            reps.sort_by(|a, b| a.index.cmp(&b.index));
            FpService {
                project: s.project.clone(),
                service: s.service.clone(),
                image: s.image.clone(),
                state: s.state,
                message: s.message.clone(),
                container_id: s.container_id.clone(),
                desired_replicas: s.desired_replicas,
                running_replicas: s.running_replicas,
                replicas: reps
                    .iter()
                    .map(|r| FpReplica {
                        index: r.index,
                        container_id: r.container_id.clone(),
                        host_port: r.host_port,
                        state: r.state,
                        image: r.image.clone(),
                        healthy: r.healthy,
                    })
                    .collect(),
            }
        })
        .collect();

    let mut edge_routes = status.edge_routes.clone();
    edge_routes.sort_by(|a, b| a.domain.cmp(&b.domain));

    let payload = FpStatusPayload {
        node_id: status.node_id.clone(),
        agent_id: status.agent_id.clone(),
        agent_version: status.agent_version.clone(),
        caddy: FpCaddy {
            managed: status.caddy.managed,
            error: status.caddy.error.clone(),
        },
        services: fp_services,
        edge_routes,
    };
    canonical_hash(&payload)
}

// ── fingerprintShard ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FpShardPayload {
    node_id: String,
    private_ip: String,
    backends: Vec<UpstreamBackend>,
}

/// Hash an [`UpstreamShard`] over its routing-relevant fields only (drops `updatedAt`).
pub fn fingerprint_shard(shard: &UpstreamShard) -> String {
    let mut backends = shard.backends.clone();
    backends.sort_by(|a, b| {
        format!("{}:{}", a.domain, a.host_port).cmp(&format!("{}:{}", b.domain, b.host_port))
    });
    let payload = FpShardPayload {
        node_id: shard.node_id.clone(),
        private_ip: shard.private_ip.clone(),
        backends,
    };
    canonical_hash(&payload)
}

// ── decideStatusWrite ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteReason {
    First,
    Changed,
    Liveness,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteDecision {
    pub write: bool,
    pub reason: WriteReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteTracker {
    /// Fingerprint of the last status written, or None before the first write.
    pub fingerprint: Option<String>,
    /// Wall-clock ms of the last write.
    pub last_write_ms: i64,
}

/// Decide whether to publish status: always on the first tick or a real change,
/// otherwise only when the liveness heartbeat is due.
pub fn decide_status_write(
    prev: &WriteTracker,
    fingerprint: &str,
    now_ms: i64,
    liveness_ms: i64,
) -> WriteDecision {
    if prev.fingerprint.is_none() {
        return WriteDecision {
            write: true,
            reason: WriteReason::First,
        };
    }
    if prev.fingerprint.as_deref() != Some(fingerprint) {
        return WriteDecision {
            write: true,
            reason: WriteReason::Changed,
        };
    }
    if now_ms - prev.last_write_ms >= liveness_ms {
        return WriteDecision {
            write: true,
            reason: WriteReason::Liveness,
        };
    }
    WriteDecision {
        write: false,
        reason: WriteReason::Skip,
    }
}

// ── createStatusWriter ─────────────────────────────────────────────────────────────

/// A stateful status publisher holding the in-memory write tracker for one process.
pub struct StatusWriter {
    liveness_ms: i64,
    prev: WriteTracker,
}

impl StatusWriter {
    pub fn new(liveness_ms: i64) -> Self {
        Self {
            liveness_ms,
            prev: WriteTracker {
                fingerprint: None,
                last_write_ms: 0,
            },
        }
    }

    /// Conditionally PUT status — writes on first tick / change / liveness-due, else skips.
    pub fn maybe_write(
        &mut self,
        status: &NodeStatus,
        now_ms: i64,
        mut put: impl FnMut(&NodeStatus),
    ) -> WriteReason {
        let fingerprint = fingerprint_status(status);
        let decision = decide_status_write(&self.prev, &fingerprint, now_ms, self.liveness_ms);
        if decision.write {
            put(status);
            self.prev.fingerprint = Some(fingerprint);
            self.prev.last_write_ms = now_ms;
        }
        decision.reason
    }

    /// Unconditional PUT (mid-rollout heartbeat / error path) that still refreshes the tracker.
    pub fn force_write(
        &mut self,
        status: &NodeStatus,
        now_ms: i64,
        mut put: impl FnMut(&NodeStatus),
    ) {
        put(status);
        self.prev.fingerprint = Some(fingerprint_status(status));
        self.prev.last_write_ms = now_ms;
    }
}

// ── resolveLiveness ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLiveness {
    pub liveness_ms: i64,
    pub warnings: Vec<String>,
}

/// Resolve the effective liveness interval, clamping it under the stale window and
/// surfacing warnings the agent logs at startup. `liveness_ms` is an `f64` so the
/// "invalid value" path (NaN / ≤0) can be exercised exactly as in TS.
pub fn resolve_liveness(liveness_ms: f64, poll_ms: i64, stale_ms: i64) -> ResolvedLiveness {
    let mut warnings = Vec::new();
    let max_safe = stale_ms / 2;
    let resolved: i64;

    if !liveness_ms.is_finite() || liveness_ms <= 0.0 {
        warnings.push(format!("invalid liveness {liveness_ms}; using {max_safe}ms"));
        resolved = max_safe;
    } else if liveness_ms > max_safe as f64 {
        warnings.push(format!(
            "liveness {liveness_ms}ms exceeds half the {stale_ms}ms stale window; clamping to {max_safe}ms"
        ));
        resolved = max_safe;
    } else {
        resolved = liveness_ms as i64;
    }

    if poll_ms >= stale_ms {
        warnings.push(format!(
            "poll {poll_ms}ms >= {stale_ms}ms stale window — liveness only fires per tick, so the node may read stale between ticks; lower LAUNCHPAD_POLL_MS"
        ));
    }

    ResolvedLiveness {
        liveness_ms: resolved,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CaddyStatus, EdgeRouteStatus};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn replica() -> ReplicaStatus {
        ReplicaStatus {
            index: 0,
            container_id: Some("c0".into()),
            host_port: Some(20000),
            state: ServiceState::Running,
            image: "img:1".into(),
            healthy: true,
        }
    }

    fn status() -> NodeStatus {
        NodeStatus {
            node_id: "app-1".into(),
            agent_id: "agent-1".into(),
            last_seen: "2026-06-04T00:00:00.000Z".into(),
            agent_version: "1.0.0".into(),
            services: vec![ServiceStatus {
                project: "blog".into(),
                service: "web".into(),
                image: "img:1".into(),
                state: ServiceState::Running,
                message: "running".into(),
                container_id: Some("c0".into()),
                replicas: vec![replica()],
                desired_replicas: 1,
                running_replicas: 1,
                cron: None,
                updated_at: "2026-06-04T00:00:00.000Z".into(),
            }],
            caddy: CaddyStatus {
                managed: true,
                last_reload_at: Some("2026-06-04T00:00:00.000Z".into()),
                error: None,
            },
            edge_routes: vec![],
            host: None,
        }
    }

    fn shard() -> UpstreamShard {
        UpstreamShard {
            node_id: "app-1".into(),
            private_ip: "10.0.1.5".into(),
            updated_at: "2026-06-04T00:00:00.000Z".into(),
            backends: vec![UpstreamBackend {
                domain: "app.example.com".into(),
                host_port: 20001,
                health_path: Some("/health".into()),
            }],
        }
    }

    // ── fingerprintStatus ──
    #[test]
    fn ignores_lastseen_per_service_updatedat_and_caddy_lastreloadat() {
        let a = status();
        let mut b = status();
        b.last_seen = "2026-06-04T01:23:45.000Z".into();
        b.caddy = CaddyStatus {
            managed: true,
            last_reload_at: Some("2026-06-04T09:99:99.000Z".into()),
            error: None,
        };
        b.services[0].updated_at = "2026-06-04T05:05:05.000Z".into();
        assert_eq!(fingerprint_status(&a), fingerprint_status(&b));
    }

    #[test]
    fn changes_when_a_replica_image_changes() {
        let a = status();
        let mut b = status();
        b.services[0].replicas = vec![ReplicaStatus {
            image: "img:2".into(),
            ..replica()
        }];
        assert_ne!(fingerprint_status(&a), fingerprint_status(&b));
    }

    #[test]
    fn changes_when_a_replica_state_changes() {
        let a = status();
        let mut b = status();
        b.services[0].replicas = vec![ReplicaStatus {
            state: ServiceState::Stopped,
            healthy: false,
            ..replica()
        }];
        assert_ne!(fingerprint_status(&a), fingerprint_status(&b));
    }

    #[test]
    fn changes_when_an_error_message_appears() {
        let a = status();
        let mut b = status();
        b.services[0].state = ServiceState::Error;
        b.services[0].message = "boom".into();
        assert_ne!(fingerprint_status(&a), fingerprint_status(&b));
    }

    #[test]
    fn is_stable_under_replica_reordering() {
        let mut ordered = status();
        ordered.services[0].replicas = vec![
            ReplicaStatus {
                index: 0,
                ..replica()
            },
            ReplicaStatus {
                index: 1,
                container_id: Some("c1".into()),
                host_port: Some(20001),
                ..replica()
            },
        ];
        let mut reversed = status();
        reversed.services[0].replicas = vec![
            ReplicaStatus {
                index: 1,
                container_id: Some("c1".into()),
                host_port: Some(20001),
                ..replica()
            },
            ReplicaStatus {
                index: 0,
                ..replica()
            },
        ];
        assert_eq!(fingerprint_status(&ordered), fingerprint_status(&reversed));
    }

    #[test]
    fn changes_when_edge_route_counts_change() {
        let mut a = status();
        a.services = vec![];
        a.edge_routes = vec![EdgeRouteStatus {
            domain: "a.com".into(),
            upstreams: 1,
        }];
        let mut b = status();
        b.services = vec![];
        b.edge_routes = vec![EdgeRouteStatus {
            domain: "a.com".into(),
            upstreams: 2,
        }];
        assert_ne!(fingerprint_status(&a), fingerprint_status(&b));
    }

    // ── decideStatusWrite ──
    #[test]
    fn writes_on_the_first_tick_no_prior_fingerprint() {
        assert_eq!(
            decide_status_write(
                &WriteTracker {
                    fingerprint: None,
                    last_write_ms: 0
                },
                "abc",
                1_000,
                30_000
            ),
            WriteDecision {
                write: true,
                reason: WriteReason::First
            }
        );
    }

    #[test]
    fn writes_when_the_fingerprint_changes() {
        assert_eq!(
            decide_status_write(
                &WriteTracker {
                    fingerprint: Some("old".into()),
                    last_write_ms: 1_000
                },
                "abc",
                2_000,
                30_000
            ),
            WriteDecision {
                write: true,
                reason: WriteReason::Changed
            }
        );
    }

    #[test]
    fn skips_when_stable_and_liveness_is_not_due() {
        assert_eq!(
            decide_status_write(
                &WriteTracker {
                    fingerprint: Some("abc".into()),
                    last_write_ms: 1_000
                },
                "abc",
                10_000,
                30_000
            ),
            WriteDecision {
                write: false,
                reason: WriteReason::Skip
            }
        );
    }

    #[test]
    fn writes_a_liveness_heartbeat_when_stable_but_interval_elapsed() {
        assert_eq!(
            decide_status_write(
                &WriteTracker {
                    fingerprint: Some("abc".into()),
                    last_write_ms: 1_000
                },
                "abc",
                31_000,
                30_000
            ),
            WriteDecision {
                write: true,
                reason: WriteReason::Liveness
            }
        );
    }

    // ── createStatusWriter ──
    #[test]
    fn writes_once_then_skips_unchanged_until_liveness_due() {
        let mut writer = StatusWriter::new(30_000);
        let writes = Rc::new(RefCell::new(Vec::<NodeStatus>::new()));

        let w = writes.clone();
        assert_eq!(
            writer.maybe_write(&status(), 0, move |s| w.borrow_mut().push(s.clone())),
            WriteReason::First
        );
        let mut s1 = status();
        s1.last_seen = "x".into();
        let w = writes.clone();
        assert_eq!(
            writer.maybe_write(&s1, 10_000, move |s| w.borrow_mut().push(s.clone())),
            WriteReason::Skip
        );
        let mut s2 = status();
        s2.last_seen = "y".into();
        let w = writes.clone();
        assert_eq!(
            writer.maybe_write(&s2, 20_000, move |s| w.borrow_mut().push(s.clone())),
            WriteReason::Skip
        );
        let mut s3 = status();
        s3.last_seen = "z".into();
        let w = writes.clone();
        assert_eq!(
            writer.maybe_write(&s3, 30_000, move |s| w.borrow_mut().push(s.clone())),
            WriteReason::Liveness
        );
        assert_eq!(writes.borrow().len(), 2);
    }

    #[test]
    fn writes_immediately_when_content_changes_before_liveness_due() {
        let mut writer = StatusWriter::new(30_000);
        let writes = Rc::new(RefCell::new(Vec::<NodeStatus>::new()));

        let w = writes.clone();
        writer.maybe_write(&status(), 0, move |s| w.borrow_mut().push(s.clone()));
        let mut changed = status();
        changed.services[0].replicas = vec![ReplicaStatus {
            image: "img:2".into(),
            ..replica()
        }];
        let w = writes.clone();
        assert_eq!(
            writer.maybe_write(&changed, 5_000, move |s| w.borrow_mut().push(s.clone())),
            WriteReason::Changed
        );
        assert_eq!(writes.borrow().len(), 2);
    }

    #[test]
    fn force_write_always_puts_and_refreshes_the_tracker() {
        let mut writer = StatusWriter::new(30_000);
        let count = Rc::new(RefCell::new(0usize));

        let c = count.clone();
        writer.force_write(&status(), 0, move |_s| *c.borrow_mut() += 1);
        let mut s1 = status();
        s1.last_seen = "x".into();
        let c = count.clone();
        writer.force_write(&s1, 1_000, move |_s| *c.borrow_mut() += 1);
        assert_eq!(*count.borrow(), 2);

        // After a forced write the tracker is current, so an unchanged maybeWrite skips.
        let mut s2 = status();
        s2.last_seen = "y".into();
        let c = count.clone();
        assert_eq!(
            writer.maybe_write(&s2, 2_000, move |_s| *c.borrow_mut() += 1),
            WriteReason::Skip
        );
        assert_eq!(*count.borrow(), 2);
    }

    // ── fingerprintShard ──
    #[test]
    fn shard_ignores_updatedat() {
        let mut later = shard();
        later.updated_at = "later".into();
        assert_eq!(fingerprint_shard(&shard()), fingerprint_shard(&later));
    }

    #[test]
    fn shard_changes_when_a_backend_host_port_changes() {
        let a = shard();
        let mut b = shard();
        b.backends = vec![UpstreamBackend {
            domain: "app.example.com".into(),
            host_port: 20009,
            health_path: Some("/health".into()),
        }];
        assert_ne!(fingerprint_shard(&a), fingerprint_shard(&b));
    }

    #[test]
    fn shard_changes_when_the_private_ip_changes() {
        let mut b = shard();
        b.private_ip = "10.0.9.9".into();
        assert_ne!(fingerprint_shard(&shard()), fingerprint_shard(&b));
    }

    #[test]
    fn shard_is_stable_under_backend_reordering() {
        let mut a = shard();
        a.backends = vec![
            UpstreamBackend {
                domain: "a.com".into(),
                host_port: 1,
                health_path: None,
            },
            UpstreamBackend {
                domain: "b.com".into(),
                host_port: 2,
                health_path: None,
            },
        ];
        let mut b = shard();
        b.backends = vec![
            UpstreamBackend {
                domain: "b.com".into(),
                host_port: 2,
                health_path: None,
            },
            UpstreamBackend {
                domain: "a.com".into(),
                host_port: 1,
                health_path: None,
            },
        ];
        assert_eq!(fingerprint_shard(&a), fingerprint_shard(&b));
    }

    // ── cross-language byte-parity (golden hashes captured from the TS agent) ──
    // Generated by running the real `fingerprintStatus`/`fingerprintShard` from
    // packages/agent/src/status-write.ts over these exact fixtures (via tsx). Proves
    // the Rust canonical-JSON + sha256 produces byte-identical hashes to TypeScript.
    #[test]
    fn fingerprint_status_matches_the_typescript_golden_hash() {
        assert_eq!(
            fingerprint_status(&status()),
            "d08eeb4a11a532815f8408cc03f211523f0ece4605fa64bb358e462b9702c482"
        );
    }

    #[test]
    fn fingerprint_shard_matches_the_typescript_golden_hash() {
        assert_eq!(
            fingerprint_shard(&shard()),
            "bd9bc42fa166a15f88d0a1834a08a92699827820df6d24597a5697edf5647fdb"
        );
    }

    // ── resolveLiveness ──
    #[test]
    fn keeps_a_sane_default_under_the_stale_window() {
        let r = resolve_liveness(30_000.0, 10_000, 60_000);
        assert_eq!(r.liveness_ms, 30_000);
        assert_eq!(r.warnings.len(), 0);
    }

    #[test]
    fn clamps_a_liveness_that_exceeds_half_the_stale_window() {
        let r = resolve_liveness(90_000.0, 10_000, 60_000);
        assert_eq!(r.liveness_ms, 30_000);
        assert!(r.warnings.iter().any(|w| w.contains("clamping")));
    }

    #[test]
    fn warns_when_the_poll_interval_is_at_or_above_the_stale_window() {
        let r = resolve_liveness(30_000.0, 60_000, 60_000);
        assert!(r.warnings.iter().any(|w| w.contains("LAUNCHPAD_POLL_MS")));
    }

    #[test]
    fn repairs_an_invalid_liveness_value() {
        let r = resolve_liveness(f64::NAN, 10_000, 60_000);
        assert_eq!(r.liveness_ms, 30_000);
        assert!(r.warnings.iter().any(|w| w.contains("invalid")));
    }
}
