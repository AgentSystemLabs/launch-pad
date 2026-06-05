//! Pure reconciliation diff. Mirrors the pure half of `packages/agent/src/reconcile.ts`
//! (`replicaNeedsReplace` + `planReconcile`). The imperative `applyActions` /
//! `rolloutService` land in Phase 5.

use std::cmp::max;
use std::collections::{BTreeMap, BTreeSet};

use crate::docker::{container_name, ManagedReplica};
use crate::health::rollout_health_ceiling_ms;
use crate::types::{parse_duration_ms, service_key, DesiredState, HealthCheck, ServiceConfig};

/// The reconcile actions produced by [`plan_reconcile`] (mirrors the TS `Action` union).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Create {
        config: ServiceConfig,
        index: i64,
    },
    Start {
        config: ServiceConfig,
        index: i64,
        id: String,
    },
    ScaleDown {
        config: ServiceConfig,
        remove: Vec<ManagedReplica>,
    },
    Rollout {
        config: ServiceConfig,
        replicas: Vec<ManagedReplica>,
    },
    Remove {
        key: String,
        replicas: Vec<ManagedReplica>,
    },
    Noop {
        config: ServiceConfig,
    },
}

impl Action {
    /// The `.type` discriminator string used by the TS tests.
    pub fn type_name(&self) -> &'static str {
        match self {
            Action::Create { .. } => "create",
            Action::Start { .. } => "start",
            Action::ScaleDown { .. } => "scaleDown",
            Action::Rollout { .. } => "rollout",
            Action::Remove { .. } => "remove",
            Action::Noop { .. } => "noop",
        }
    }

    /// The service config carried by the action, or None for `remove` (which has none).
    pub fn config(&self) -> Option<&ServiceConfig> {
        match self {
            Action::Create { config, .. }
            | Action::Start { config, .. }
            | Action::ScaleDown { config, .. }
            | Action::Rollout { config, .. }
            | Action::Noop { config } => Some(config),
            Action::Remove { .. } => None,
        }
    }
}

/// True when a live replica must be replaced to match desired (image or resources).
pub fn replica_needs_replace(replica: &ManagedReplica, config: &ServiceConfig) -> bool {
    replica.image != config.image || replica.cpu != config.cpu || replica.memory != config.memory
}

/// Pure diff over the replica set. Reasons by COUNT (not fixed indices) so a service
/// whose replicas live at non-`0..N-1` indices (after a rollout) is still "converged".
/// Image or cpu/memory drift collapses to a single `rollout` action.
pub fn plan_reconcile(
    desired: &DesiredState,
    actual: &BTreeMap<String, Vec<ManagedReplica>>,
) -> Vec<Action> {
    let mut actions: Vec<Action> = Vec::new();
    let mut desired_keys: BTreeSet<String> = BTreeSet::new();

    for c in &desired.services {
        let key = service_key(&c.project, &c.service);
        desired_keys.insert(key.clone());
        let empty: Vec<ManagedReplica> = Vec::new();
        let have: &[ManagedReplica] = actual.get(&key).unwrap_or(&empty);

        if have.iter().any(|r| replica_needs_replace(r, c)) {
            actions.push(Action::Rollout {
                config: c.clone(),
                replicas: have.to_vec(),
            });
            continue;
        }

        let stopped: Vec<&ManagedReplica> = have.iter().filter(|r| r.state != "running").collect();
        for r in &stopped {
            actions.push(Action::Start {
                config: c.clone(),
                index: r.index,
                id: r.id.clone(),
            });
        }

        let have_len = have.len() as i64;
        if have_len < c.replicas {
            let mut used: BTreeSet<i64> = have.iter().map(|r| r.index).collect();
            let mut idx: i64 = 0;
            for _ in have_len..c.replicas {
                while used.contains(&idx) {
                    idx += 1;
                }
                used.insert(idx);
                actions.push(Action::Create {
                    config: c.clone(),
                    index: idx,
                });
                idx += 1;
            }
        } else if have_len > c.replicas {
            let mut extras = have.to_vec();
            extras.sort_by(|a, b| b.index.cmp(&a.index)); // highest indices first
            extras.truncate((have_len - c.replicas) as usize);
            actions.push(Action::ScaleDown {
                config: c.clone(),
                remove: extras,
            });
        } else if stopped.is_empty() {
            actions.push(Action::Noop { config: c.clone() });
        }
    }

    for (key, replicas) in actual {
        if !desired_keys.contains(key) {
            actions.push(Action::Remove {
                key: key.clone(),
                replicas: replicas.clone(),
            });
        }
    }

    actions
}

// ── imperative apply (mirrors `applyActions` / `rolloutService` in reconcile.ts) ─────

/// The side effects `apply_actions` drives. Injected so the imperative reconcile tests
/// offline; the agent supplies the real docker/caddy/health/port adapters in Phase 6.
/// The fallible ops mirror the TS functions that can throw (caught into `errors`).
pub trait Reconciler {
    fn pull(&mut self, image: &str) -> Result<(), String>;
    fn run_container(
        &mut self,
        config: &ServiceConfig,
        index: i64,
        host_port: Option<i64>,
        bind_host: &str,
    ) -> Result<(), String>;
    fn start_container(&mut self, id: &str) -> Result<(), String>;
    fn stop_container(&mut self, name_or_id: &str, grace_seconds: i64) -> Result<(), String>;
    fn remove_container(&mut self, id: &str) -> Result<(), String>;
    /// "127.0.0.1" (co-located) or "0.0.0.0" (reachable by a remote edge).
    fn bind_host(&self, config: &ServiceConfig) -> String;
    fn allocate_port(&mut self, key: &str, index: i64) -> i64;
    fn release_port(&mut self, key: &str, index: i64);
    fn refresh_caddy(&mut self, exclude_ids: &BTreeSet<String>);
    fn heartbeat(&mut self);
    fn sleep_ms(&mut self, ms: i64);
    fn wait_healthy(&mut self, host_port: i64, hc: &HealthCheck, ceiling_ms: i64) -> bool;
    /// Record a per-service error (the `ctx.errors` map in the TS `ApplyContext`).
    /// `heartbeat`/status-building read it back inside the implementation.
    fn set_error(&mut self, key: &str, message: String);
}

fn apply_one<R: Reconciler>(action: &Action, ctx: &mut R) -> Result<(), String> {
    match action {
        Action::Noop { .. } => Ok(()),
        Action::Remove { replicas, .. } => {
            for r in replicas {
                ctx.remove_container(&r.id)?;
            }
            Ok(())
        }
        Action::ScaleDown { config, remove } => {
            let key = service_key(&config.project, &config.service);
            for r in remove {
                ctx.remove_container(&r.id)?;
                ctx.release_port(&key, r.index);
            }
            Ok(())
        }
        Action::Start { id, .. } => ctx.start_container(id),
        Action::Create { config, index } => {
            let key = service_key(&config.project, &config.service);
            ctx.pull(&config.image)?;
            let host_port = if config.ingress.is_some() {
                Some(ctx.allocate_port(&key, *index))
            } else {
                None
            };
            let bind = ctx.bind_host(config);
            ctx.run_container(config, *index, host_port, &bind)
        }
        Action::Rollout { config, replicas } => rollout_service(config, replicas, ctx),
    }
}

/// Execute actions sequentially. Per-action failures are recorded via `ctx.set_error`
/// (keyed by service) without aborting the remaining actions.
pub fn apply_actions<R: Reconciler>(actions: &[Action], ctx: &mut R) {
    for action in actions {
        if let Err(e) = apply_one(action, ctx) {
            if let Some(config) = action.config() {
                ctx.set_error(&service_key(&config.project, &config.service), e);
            }
        }
    }
}

/// Health-gated rolling update: surge a new replica → wait healthy → add to the LB →
/// remove one old from the LB → drain → graceful stop. Invariant: Caddy always has ≥1
/// healthy upstream for the domain, so there is no downtime.
fn rollout_service<R: Reconciler>(
    c: &ServiceConfig,
    current: &[ManagedReplica],
    ctx: &mut R,
) -> Result<(), String> {
    let key = service_key(&c.project, &c.service);
    let want = c.replicas;
    let surge = c.rollout.max_surge;
    let drain_ms = parse_duration_ms(&c.rollout.drain_timeout);
    let grace_sec = max(1, (parse_duration_ms(&c.rollout.stop_grace) + 999) / 1000);
    let hc = c.health_check.as_ref();
    let has_ingress = c.ingress.is_some();

    ctx.pull(&c.image)?;

    let mut old_queue: Vec<ManagedReplica> = current
        .iter()
        .filter(|r| replica_needs_replace(r, c))
        .cloned()
        .collect();
    let mut new_count = current.iter().filter(|r| !replica_needs_replace(r, c)).count() as i64;
    let mut next_index = current.iter().map(|r| r.index).max().map(|m| m + 1).unwrap_or(0);
    let mut draining: BTreeSet<String> = BTreeSet::new();

    loop {
        let total = old_queue.len() as i64 + new_count;
        if new_count < want && total < want + surge {
            // Surge a new replica.
            let idx = next_index;
            next_index += 1;
            let host_port = if has_ingress {
                Some(ctx.allocate_port(&key, idx))
            } else {
                None
            };
            let bind = ctx.bind_host(c);
            ctx.run_container(c, idx, host_port, &bind)?;

            if let (Some(hc), Some(host_port)) = (hc, host_port) {
                let ceiling = rollout_health_ceiling_ms(hc);
                if !ctx.wait_healthy(host_port, hc, ceiling) {
                    ctx.stop_container(&container_name(&c.project, &c.service, idx), grace_sec)?;
                    ctx.release_port(&key, idx);
                    ctx.set_error(
                        &key,
                        format!(
                            "rollout aborted: new replica failed health check for {}",
                            c.image
                        ),
                    );
                    if has_ingress {
                        ctx.refresh_caddy(&draining);
                    }
                    return Ok(());
                }
            }
            new_count += 1;
            if has_ingress {
                ctx.refresh_caddy(&draining);
                ctx.heartbeat();
            }
        } else if !old_queue.is_empty() {
            // Drain + graceful-stop one old replica.
            let old = old_queue.remove(0);
            if has_ingress {
                draining.insert(old.id.clone());
                ctx.refresh_caddy(&draining); // stop routing to it BEFORE stopping it
                ctx.heartbeat();
                if drain_ms > 0 {
                    ctx.sleep_ms(drain_ms);
                }
            }
            ctx.stop_container(&old.id, grace_sec)?;
            draining.remove(&old.id);
            ctx.release_port(&key, old.index);
            ctx.heartbeat();
        } else {
            break;
        }
    }

    if has_ingress {
        ctx.refresh_caddy(&BTreeSet::new());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Rollout, PROTOCOL_VERSION};
    use std::collections::BTreeMap;

    fn svc_n(project: &str, service: &str, image: &str, replicas: i64) -> ServiceConfig {
        ServiceConfig {
            project: project.into(),
            service: service.into(),
            image: image.into(),
            cpu: 256,
            memory: 256,
            replicas,
            env: BTreeMap::new(),
            ingress: None,
            health_check: None,
            rollout: Rollout {
                max_surge: 1,
                drain_timeout: "20s".into(),
                stop_grace: "30s".into(),
            },
        }
    }

    fn svc(project: &str, service: &str, image: &str) -> ServiceConfig {
        svc_n(project, service, image, 1)
    }

    fn desired(services: Vec<ServiceConfig>) -> DesiredState {
        DesiredState {
            version: PROTOCOL_VERSION,
            node_id: "n1".into(),
            updated_at: "now".into(),
            services,
        }
    }

    fn rep_cm(
        project: &str,
        service: &str,
        index: i64,
        image: &str,
        state: &str,
        cpu: i64,
        memory: i64,
    ) -> ManagedReplica {
        ManagedReplica {
            id: format!("id-{service}-{index}"),
            name: format!("launchpad_{project}_{service}_{index}"),
            index,
            state: state.into(),
            project: project.into(),
            service: service.into(),
            image: image.into(),
            cpu,
            memory,
            host_port: Some(20000 + index),
        }
    }

    fn rep(project: &str, service: &str, index: i64, image: &str, state: &str) -> ManagedReplica {
        rep_cm(project, service, index, image, state, 256, 256)
    }

    fn actual_map(reps: Vec<ManagedReplica>) -> BTreeMap<String, Vec<ManagedReplica>> {
        let mut m: BTreeMap<String, Vec<ManagedReplica>> = BTreeMap::new();
        for r in reps {
            let k = service_key(&r.project, &r.service);
            m.entry(k).or_default().push(r);
        }
        m
    }

    fn types_for(actions: &[Action], project: &str, service: &str) -> Vec<String> {
        actions
            .iter()
            .filter(|a| {
                a.config()
                    .is_some_and(|c| c.project == project && c.service == service)
            })
            .map(|a| a.type_name().to_string())
            .collect()
    }

    #[test]
    fn creates_a_missing_single_replica() {
        let actions = plan_reconcile(&desired(vec![svc("blog", "api", "img:1")]), &actual_map(vec![]));
        assert_eq!(types_for(&actions, "blog", "api"), vec!["create"]);
    }

    #[test]
    fn no_ops_when_the_running_image_matches() {
        let actions = plan_reconcile(
            &desired(vec![svc("blog", "api", "img:1")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["noop"]);
    }

    #[test]
    fn rolls_out_when_the_image_differs() {
        let actions = plan_reconcile(
            &desired(vec![svc("blog", "api", "img:2")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn rolls_out_when_cpu_or_memory_differs_same_image() {
        let config = svc("blog", "api", "img:1");
        let cpu_actions = plan_reconcile(
            &desired(vec![ServiceConfig {
                cpu: 512,
                ..config.clone()
            }]),
            &actual_map(vec![rep_cm("blog", "api", 0, "img:1", "running", 256, 256)]),
        );
        assert_eq!(types_for(&cpu_actions, "blog", "api"), vec!["rollout"]);

        let mem_actions = plan_reconcile(
            &desired(vec![ServiceConfig {
                memory: 512,
                ..config.clone()
            }]),
            &actual_map(vec![rep_cm("blog", "api", 0, "img:1", "running", 256, 256)]),
        );
        assert_eq!(types_for(&mem_actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn starts_a_matching_but_stopped_replica() {
        let actions = plan_reconcile(
            &desired(vec![svc("blog", "api", "img:1")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "exited")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["start"]);
    }

    #[test]
    fn creates_additional_replicas_when_scaling_up() {
        let actions = plan_reconcile(
            &desired(vec![svc_n("blog", "api", "img:1", 3)]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(
            actions
                .iter()
                .filter(|a| a.type_name() == "create")
                .count(),
            2
        );
    }

    #[test]
    fn scales_down_the_highest_indices() {
        let actions = plan_reconcile(
            &desired(vec![svc_n("blog", "api", "img:1", 1)]),
            &actual_map(vec![
                rep("blog", "api", 0, "img:1", "running"),
                rep("blog", "api", 1, "img:1", "running"),
            ]),
        );
        let sd = actions.iter().find(|a| a.type_name() == "scaleDown");
        match sd {
            Some(Action::ScaleDown { remove, .. }) => {
                assert_eq!(remove.iter().map(|r| r.index).collect::<Vec<_>>(), vec![1]);
            }
            _ => panic!("expected a scaleDown action"),
        }
    }

    #[test]
    fn removes_a_service_no_longer_desired() {
        let actions = plan_reconcile(
            &desired(vec![]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert!(actions.iter().any(|a| a.type_name() == "remove"));
    }

    #[test]
    fn treats_non_zero_to_n_minus_1_replica_indices_as_converged_post_rollout() {
        let actions = plan_reconcile(
            &desired(vec![svc_n("blog", "api", "img:1", 2)]),
            &actual_map(vec![
                rep("blog", "api", 5, "img:1", "running"),
                rep("blog", "api", 6, "img:1", "running"),
            ]),
        );
        assert_eq!(actions.iter().filter(|a| a.type_name() == "create").count(), 0);
        assert_eq!(
            actions.iter().filter(|a| a.type_name() == "scaleDown").count(),
            0
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["noop"]);
    }

    // ── Phase 5: imperative apply / rollout (new integration-style tests) ──

    use crate::types::{HealthCheck, Ingress};

    /// A `Reconciler` that records the ordered side-effect log and replays a fixed
    /// `wait_healthy` verdict; `fail_pull` injects a failing op for error-capture tests.
    struct TestReconciler {
        events: Vec<String>,
        errors: BTreeMap<String, String>,
        healthy: bool,
        fail_pull: bool,
    }

    impl TestReconciler {
        fn new() -> Self {
            Self {
                events: Vec::new(),
                errors: BTreeMap::new(),
                healthy: true,
                fail_pull: false,
            }
        }
    }

    impl Reconciler for TestReconciler {
        fn pull(&mut self, image: &str) -> Result<(), String> {
            self.events.push(format!("pull {image}"));
            if self.fail_pull {
                Err("pull failed".into())
            } else {
                Ok(())
            }
        }
        fn run_container(
            &mut self,
            config: &ServiceConfig,
            index: i64,
            host_port: Option<i64>,
            bind_host: &str,
        ) -> Result<(), String> {
            self.events.push(format!(
                "run {}/{} idx={index} port={host_port:?} bind={bind_host}",
                config.project, config.service
            ));
            Ok(())
        }
        fn start_container(&mut self, id: &str) -> Result<(), String> {
            self.events.push(format!("start {id}"));
            Ok(())
        }
        fn stop_container(&mut self, name_or_id: &str, grace_seconds: i64) -> Result<(), String> {
            self.events.push(format!("stop {name_or_id} grace={grace_seconds}"));
            Ok(())
        }
        fn remove_container(&mut self, id: &str) -> Result<(), String> {
            self.events.push(format!("remove {id}"));
            Ok(())
        }
        fn bind_host(&self, _config: &ServiceConfig) -> String {
            "127.0.0.1".into()
        }
        fn allocate_port(&mut self, key: &str, index: i64) -> i64 {
            let port = 20000 + index;
            self.events.push(format!("allocate {key}#{index}={port}"));
            port
        }
        fn release_port(&mut self, key: &str, index: i64) {
            self.events.push(format!("release {key}#{index}"));
        }
        fn refresh_caddy(&mut self, exclude_ids: &BTreeSet<String>) {
            let ids: Vec<&str> = exclude_ids.iter().map(String::as_str).collect();
            self.events.push(format!("refresh_caddy exclude={ids:?}"));
        }
        fn heartbeat(&mut self) {
            self.events.push("heartbeat".into());
        }
        fn sleep_ms(&mut self, ms: i64) {
            self.events.push(format!("sleep {ms}"));
        }
        fn wait_healthy(&mut self, host_port: i64, _hc: &HealthCheck, _ceiling_ms: i64) -> bool {
            self.events.push(format!("wait_healthy hp={host_port}"));
            self.healthy
        }
        fn set_error(&mut self, key: &str, message: String) {
            self.errors.insert(key.to_string(), message);
        }
    }

    fn svc_web(project: &str, service: &str, image: &str, replicas: i64) -> ServiceConfig {
        ServiceConfig {
            ingress: Some(Ingress {
                domain: "d".into(),
                port: 3000,
                edge: None,
            }),
            health_check: Some(HealthCheck {
                path: "/h".into(),
                port: None,
                interval_ms: 2000,
                timeout_ms: 2000,
                healthy_threshold: 2,
            }),
            ..svc_n(project, service, image, replicas)
        }
    }

    #[test]
    fn rollout_surges_health_gates_then_drains_old_keeping_caddy_serving() {
        let mut ctx = TestReconciler::new();
        apply_actions(
            &[Action::Rollout {
                config: svc_web("blog", "api", "img:2", 1),
                replicas: vec![rep("blog", "api", 0, "img:1", "running")],
            }],
            &mut ctx,
        );
        assert_eq!(
            ctx.events,
            vec![
                "pull img:2".to_string(),
                "allocate blog/api#1=20001".to_string(),
                "run blog/api idx=1 port=Some(20001) bind=127.0.0.1".to_string(),
                "wait_healthy hp=20001".to_string(),
                // new replica is in the LB BEFORE the old one is touched
                "refresh_caddy exclude=[]".to_string(),
                "heartbeat".to_string(),
                "refresh_caddy exclude=[\"id-api-0\"]".to_string(),
                "heartbeat".to_string(),
                "sleep 20000".to_string(),
                "stop id-api-0 grace=30".to_string(),
                "release blog/api#0".to_string(),
                "heartbeat".to_string(),
                "refresh_caddy exclude=[]".to_string(),
            ]
        );
        assert!(ctx.errors.is_empty());
    }

    #[test]
    fn rollout_aborts_on_a_failed_health_check_and_cleans_up_the_surged_replica() {
        let mut ctx = TestReconciler::new();
        ctx.healthy = false;
        apply_actions(
            &[Action::Rollout {
                config: svc_web("blog", "api", "img:2", 1),
                replicas: vec![rep("blog", "api", 0, "img:1", "running")],
            }],
            &mut ctx,
        );
        assert_eq!(
            ctx.events,
            vec![
                "pull img:2".to_string(),
                "allocate blog/api#1=20001".to_string(),
                "run blog/api idx=1 port=Some(20001) bind=127.0.0.1".to_string(),
                "wait_healthy hp=20001".to_string(),
                "stop launchpad_blog_api_1 grace=30".to_string(),
                "release blog/api#1".to_string(),
                "refresh_caddy exclude=[]".to_string(),
            ]
        );
        assert_eq!(
            ctx.errors.get("blog/api").map(String::as_str),
            Some("rollout aborted: new replica failed health check for img:2")
        );
    }

    #[test]
    fn scale_down_removes_and_releases_each_extra_replica() {
        let mut ctx = TestReconciler::new();
        apply_actions(
            &[Action::ScaleDown {
                config: svc_n("blog", "api", "img:1", 1),
                remove: vec![rep("blog", "api", 1, "img:1", "running")],
            }],
            &mut ctx,
        );
        assert_eq!(
            ctx.events,
            vec!["remove id-api-1".to_string(), "release blog/api#1".to_string()]
        );
        assert!(ctx.errors.is_empty());
    }

    #[test]
    fn a_failed_action_is_captured_into_errors_without_aborting_the_pass() {
        let mut ctx = TestReconciler::new();
        ctx.fail_pull = true;
        apply_actions(
            &[Action::Create {
                config: svc_web("blog", "api", "img:1", 1),
                index: 0,
            }],
            &mut ctx,
        );
        assert_eq!(ctx.errors.get("blog/api").map(String::as_str), Some("pull failed"));
    }
}
