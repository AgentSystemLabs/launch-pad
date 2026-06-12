//! Reconciliation planning + imperative apply. Mirrors `packages/agent/src/reconcile.ts`
//! (`replicaNeedsReplace`, `planReconcile`, `planCronService`, `applyActions`,
//! `rolloutService`). The planner is pure; apply drives side effects through the
//! injected [`Reconciler`] trait so the rollout state machine tests offline.

use std::cmp::max;
use std::collections::{BTreeMap, BTreeSet};

use crate::cron::{due_cron_fire, parse_cron_expression};
use crate::docker::{container_name, ManagedReplica};
use crate::health::rollout_health_ceiling_ms;
use crate::types::{
    parse_duration_ms, service_config_stamp, service_key, DesiredState, HealthCheck, ServiceConfig,
};

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
    CronRun {
        config: ServiceConfig,
        fire_ms: i64,
        previous: Vec<ManagedReplica>,
    },
    CronSkip {
        config: ServiceConfig,
        fire_ms: i64,
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
            Action::CronRun { .. } => "cronRun",
            Action::CronSkip { .. } => "cronSkip",
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
            | Action::CronRun { config, .. }
            | Action::CronSkip { config, .. }
            | Action::Noop { config } => Some(config),
            Action::Remove { .. } => None,
        }
    }
}

/// Inputs the cron due-run decision needs, injected so the planner stays pure.
/// `last_fires` carries, per service key, the last fire the agent recorded in
/// local state — or the first-sight ANCHOR (seeded by the tick before planning)
/// so a freshly-deployed job never "catches up" on fires that predate it.
#[derive(Debug, Clone, Default)]
pub struct CronPlanContext {
    pub now_ms: i64,
    pub last_fires: BTreeMap<String, i64>,
}

/// True when a live replica must be replaced to match desired (image, resources,
/// or runtime-config stamp).
pub fn replica_needs_replace(replica: &ManagedReplica, config: &ServiceConfig) -> bool {
    replica.image != config.image
        || replica.cpu != config.cpu
        || replica.memory != config.memory
        || replica.config_stamp != service_config_stamp(config)
}

/// Plan one cron service. A scheduled job NEVER takes the long-running branches
/// (create/start/scaleDown/rollout) — a new image or config simply applies at the
/// next fire, because each run is started fresh from current desired state.
fn plan_cron_service(
    c: &ServiceConfig,
    have: &[ManagedReplica],
    key: &str,
    cron: Option<&CronPlanContext>,
    actions: &mut Vec<Action>,
) {
    // A container without the fire label is a long-running leftover from a
    // previous (non-cron) life of this key — remove it now, never at fire time.
    // Pushed BEFORE any cronRun for the same key: apply is sequential, and the
    // leftover holds the container name the run would reuse.
    let stale: Vec<ManagedReplica> = have
        .iter()
        .filter(|r| r.cron_fire_ms.is_none())
        .cloned()
        .collect();
    if !stale.is_empty() {
        actions.push(Action::Remove {
            key: key.to_string(),
            replicas: stale,
        });
    }

    let runs: Vec<&ManagedReplica> = have.iter().filter(|r| r.cron_fire_ms.is_some()).collect();

    let Some(cron) = cron else {
        actions.push(Action::Noop { config: c.clone() });
        return;
    };

    // The CLI validates expressions before publishing; an unparseable one here
    // is defensive only — do nothing rather than run wild.
    let Ok(schedule) = parse_cron_expression(c.cron.as_deref().unwrap_or("")) else {
        actions.push(Action::Noop { config: c.clone() });
        return;
    };

    let label_fire = runs.iter().fold(0, |m, r| max(m, r.cron_fire_ms.unwrap_or(0)));
    let anchored = cron.last_fires.get(key).copied();
    // No durable record at all → the tick hasn't seeded the anchor yet; never fire
    // off an unanchored schedule (it would replay history).
    if label_fire == 0 && anchored.is_none() {
        actions.push(Action::Noop { config: c.clone() });
        return;
    }
    let last_fire = max(label_fire, anchored.unwrap_or(0));

    let Some(due) = due_cron_fire(&schedule, last_fire, cron.now_ms) else {
        actions.push(Action::Noop { config: c.clone() });
        return;
    };

    // A run still in progress suppresses the due fire — overlapping runs are never
    // started. The fire is RECORDED as skipped (cronSkip), not left pending:
    // otherwise a run longer than the schedule interval would trigger an immediate
    // back-to-back execution the moment it exits, instead of waiting for the next
    // scheduled fire.
    if runs.iter().any(|r| r.state == "running") {
        actions.push(Action::CronSkip {
            config: c.clone(),
            fire_ms: due,
        });
        return;
    }

    actions.push(Action::CronRun {
        config: c.clone(),
        fire_ms: due,
        previous: runs.into_iter().cloned().collect(),
    });
}

/// Pure diff over the replica set. Reasons by COUNT (not fixed indices) so a service
/// whose replicas live at non-`0..N-1` indices (after a rollout) is still "converged".
/// Image or cpu/memory/stamp drift collapses to a single `rollout` action.
pub fn plan_reconcile(
    desired: &DesiredState,
    actual: &BTreeMap<String, Vec<ManagedReplica>>,
    cron: Option<&CronPlanContext>,
) -> Vec<Action> {
    let mut actions: Vec<Action> = Vec::new();
    let mut desired_keys: BTreeSet<String> = BTreeSet::new();

    for c in &desired.services {
        let key = service_key(&c.project, &c.service);
        desired_keys.insert(key.clone());
        let empty: Vec<ManagedReplica> = Vec::new();
        let have: &[ManagedReplica] = actual.get(&key).unwrap_or(&empty);

        if c.cron.is_some() {
            plan_cron_service(c, have, &key, cron, &mut actions);
            continue;
        }

        if have.iter().any(|r| replica_needs_replace(r, c)) {
            actions.push(Action::Rollout {
                config: c.clone(),
                replicas: have.to_vec(),
            });
            continue;
        }

        // A `start` is a bare `docker start` of the EXISTING container, so it's only
        // safe because the `replica_needs_replace` branch above already short-circuited
        // any replica whose image/cpu/memory/stamp drifted — a stopped replica that
        // reaches here is guaranteed to still match desired. Do not move this branch
        // above the replace check or a `start` could resurrect a stale container.
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
/// offline; the agent supplies the real docker/routing/health/port adapters in the
/// binary. The fallible ops mirror the TS functions that can throw (caught into errors).
pub trait Reconciler {
    fn pull(&mut self, image: &str) -> Result<(), String>;
    fn run_container(
        &mut self,
        config: &ServiceConfig,
        index: i64,
        host_port: Option<i64>,
        bind_host: &str,
        cron_fire_ms: Option<i64>,
    ) -> Result<(), String>;
    fn start_container(&mut self, id: &str) -> Result<(), String>;
    fn stop_container(&mut self, name_or_id: &str, grace_seconds: i64) -> Result<(), String>;
    fn remove_container(&mut self, id: &str) -> Result<(), String>;
    /// "127.0.0.1" (worker) or "0.0.0.0" (web — dialed by the edge over the VPC).
    fn bind_host(&self, config: &ServiceConfig) -> String;
    fn allocate_port(&mut self, key: &str, index: i64) -> i64;
    fn release_port(&mut self, key: &str, index: i64);
    /// Rebuild + publish ROUTING (the upstream shards remote edges consume) from live
    /// replicas, excluding the given container ids. Must happen mid-rollout, not at
    /// tick end, or the edge keeps routing to replicas the rollout already stopped.
    /// FALLIBLE on purpose: a failed shard publish must abort the rollout step — the
    /// drain path otherwise stops a replica the edge is still routing to (502s).
    fn refresh_routing(&mut self, exclude_ids: &BTreeSet<String>) -> Result<(), String>;
    /// Floor on the drain wait before stopping an old replica: a REMOTE edge's routing
    /// update is asynchronous (S3 shard → edge poll → Caddy reload), so the wait must
    /// cover that propagation even when the user's drainTimeout is shorter.
    fn drain_floor_ms(&self, config: &ServiceConfig) -> i64;
    /// Re-write status.json (keeps the heartbeat fresh during long rollouts).
    fn heartbeat(&mut self);
    fn sleep_ms(&mut self, ms: i64);
    fn wait_healthy(&mut self, host_port: i64, hc: &HealthCheck, ceiling_ms: i64) -> bool;
    /// Persist the fire time of a cron run that is about to start (crash-safe dedupe).
    /// MUST be durable before the run starts — an Err refuses the run.
    fn record_cron_fire(&mut self, key: &str, fire_ms: i64) -> Result<(), String>;
    /// Record a per-service error (the `ctx.errors` map in the TS `ApplyContext`).
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
            ctx.run_container(config, *index, host_port, &bind, None)
        }
        Action::Rollout { config, replicas } => rollout_service(config, replicas, ctx),
        Action::CronRun {
            config,
            fire_ms,
            previous,
        } => {
            let key = service_key(&config.project, &config.service);
            ctx.pull(&config.image)?;
            // The previous run already exited (the planner never replaces a running
            // one) — removing it frees the container name for the new run while its
            // logs have already shipped to CloudWatch.
            for r in previous {
                ctx.remove_container(&r.id)?;
            }
            // Record the fire BEFORE starting the container: if the agent crashes
            // between the two, the worst case is a skipped run, never a duplicate.
            ctx.record_cron_fire(&key, *fire_ms)?;
            let bind = ctx.bind_host(config);
            ctx.run_container(config, 0, None, &bind, Some(*fire_ms))
        }
        Action::CronSkip { config, fire_ms } => {
            // A fire elapsed while a run was still in progress: record it so the
            // run's exit doesn't trigger an immediate catch-up execution.
            ctx.record_cron_fire(&service_key(&config.project, &config.service), *fire_ms)
        }
    }
}

/// Execute actions sequentially. Per-action failures are intentionally ISOLATED:
/// recorded via `ctx.set_error` (keyed by service, surfaces in the status message)
/// without aborting the remaining actions — one bad service can't wedge
/// reconciliation for every other service. The next tick retries from scratch.
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
/// healthy upstream for the domain, so there is no downtime. "The LB" lives on a
/// remote edge node — every refresh_routing call re-publishes this node's upstream
/// shards, and the drain wait is floored at the edge's propagation time, so the
/// invariant holds across the S3 → edge-poll → Caddy-reload hop.
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

    // Hand-rolled state machine with three branches, run until convergence:
    //   1. surge   — too few new replicas and headroom under want+surge → start one
    //   2. drain   — new replicas satisfied but old ones remain → retire one old
    //   3. break   — no old left and new count met → done
    // Termination: every surge increments new_count (or returns on health failure)
    // and every drain shrinks old_queue, so the loop cannot spin forever.
    loop {
        let total = old_queue.len() as i64 + new_count;
        if new_count < want && total < want + surge {
            // Branch 1: surge a new replica.
            let idx = next_index;
            next_index += 1;
            let host_port = if has_ingress {
                Some(ctx.allocate_port(&key, idx))
            } else {
                None
            };
            let bind = ctx.bind_host(c);
            ctx.run_container(c, idx, host_port, &bind, None)?;

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
                        ctx.refresh_routing(&draining)?;
                    }
                    return Ok(());
                }
            }
            new_count += 1;
            if has_ingress {
                ctx.refresh_routing(&draining)?;
                ctx.heartbeat();
            }
        } else if !old_queue.is_empty() {
            // Branch 2: drain + graceful-stop one old replica.
            let old = old_queue.remove(0);
            if has_ingress {
                draining.insert(old.id.clone());
                // Stop routing to it BEFORE stopping it. A failed publish ABORTS the
                // rollout here — proceeding would stop a replica the edge still
                // routes to; the next tick retries from current live state.
                ctx.refresh_routing(&draining)?;
                ctx.heartbeat();
                // The wait must outlast routing propagation (see drain_floor_ms) or the
                // stop below kills a replica the edge is still sending requests to.
                let wait_ms = max(drain_ms, ctx.drain_floor_ms(c));
                if wait_ms > 0 {
                    ctx.sleep_ms(wait_ms);
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
        ctx.refresh_routing(&BTreeSet::new())?;
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
            secret_refs: vec![],
            restart_at: None,
            cron: None,
            ingress: None,
            health_check: None,
            rollout: Rollout {
                max_surge: 1,
                drain_timeout: "20s".into(),
                stop_grace: "30s".into(),
            },
            volumes: vec![],
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
        // The stamp matches what `svc`/`svc_n` produce (no env/refs/restartAt/volumes),
        // so only deliberately-drifted fields trigger a replace in tests.
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
            config_stamp: r#"{"env":{},"restartAt":null,"secretRefs":[]}"#.into(),
            cron_fire_ms: None,
            exit_code: if state == "exited" { Some(0) } else { None },
        }
    }

    fn rep(project: &str, service: &str, index: i64, image: &str, state: &str) -> ManagedReplica {
        rep_cm(project, service, index, image, state, 256, 256)
    }

    fn cron_rep(
        project: &str,
        service: &str,
        fire_ms: i64,
        state: &str,
        exit_code: Option<i64>,
    ) -> ManagedReplica {
        ManagedReplica {
            cron_fire_ms: Some(fire_ms),
            exit_code,
            ..rep(project, service, 0, "img:1", state)
        }
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

    fn plan(desired_state: &DesiredState, actual: &BTreeMap<String, Vec<ManagedReplica>>) -> Vec<Action> {
        plan_reconcile(desired_state, actual, None)
    }

    #[test]
    fn creates_a_missing_single_replica() {
        let actions = plan(&desired(vec![svc("blog", "api", "img:1")]), &actual_map(vec![]));
        assert_eq!(types_for(&actions, "blog", "api"), vec!["create"]);
    }

    #[test]
    fn no_ops_when_the_running_image_matches() {
        let actions = plan(
            &desired(vec![svc("blog", "api", "img:1")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["noop"]);
    }

    #[test]
    fn rolls_out_when_the_image_differs() {
        let actions = plan(
            &desired(vec![svc("blog", "api", "img:2")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn rolls_out_when_cpu_or_memory_differs_same_image() {
        let config = svc("blog", "api", "img:1");
        let cpu_actions = plan(
            &desired(vec![ServiceConfig {
                cpu: 512,
                ..config.clone()
            }]),
            &actual_map(vec![rep_cm("blog", "api", 0, "img:1", "running", 256, 256)]),
        );
        assert_eq!(types_for(&cpu_actions, "blog", "api"), vec!["rollout"]);

        let mem_actions = plan(
            &desired(vec![ServiceConfig {
                memory: 512,
                ..config.clone()
            }]),
            &actual_map(vec![rep_cm("blog", "api", 0, "img:1", "running", 256, 256)]),
        );
        assert_eq!(types_for(&mem_actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn rolls_out_when_the_config_stamp_drifts() {
        // Same image/resources, but desired env changed → stamp differs → rollout.
        let mut config = svc("blog", "api", "img:1");
        config.env = BTreeMap::from([("NEW_VAR".to_string(), "1".to_string())]);
        let actions = plan(
            &desired(vec![config]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn restart_at_bump_forces_a_rollout() {
        let mut config = svc("blog", "api", "img:1");
        config.restart_at = Some("2026-06-12T00:00:00.000Z".into());
        let actions = plan(
            &desired(vec![config]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["rollout"]);
    }

    #[test]
    fn starts_a_matching_but_stopped_replica() {
        let actions = plan(
            &desired(vec![svc("blog", "api", "img:1")]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "exited")]),
        );
        assert_eq!(types_for(&actions, "blog", "api"), vec!["start"]);
    }

    #[test]
    fn creates_additional_replicas_when_scaling_up() {
        let actions = plan(
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
        let actions = plan(
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
        let actions = plan(
            &desired(vec![]),
            &actual_map(vec![rep("blog", "api", 0, "img:1", "running")]),
        );
        assert!(actions.iter().any(|a| a.type_name() == "remove"));
    }

    #[test]
    fn treats_non_zero_to_n_minus_1_replica_indices_as_converged_post_rollout() {
        let actions = plan(
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

    // ── cron planning (mirrors cron-reconcile.test.ts) ──

    fn cron_svc(expr: &str) -> ServiceConfig {
        let mut c = svc("blog", "job", "img:1");
        c.cron = Some(expr.into());
        c
    }

    fn utc(iso: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    }

    fn cron_ctx(now: &str, fires: &[(&str, i64)]) -> CronPlanContext {
        CronPlanContext {
            now_ms: utc(now),
            last_fires: fires
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
        }
    }

    #[test]
    fn a_cron_service_never_takes_the_long_running_branches() {
        // Anchored and not due → noop, even with zero containers (no create).
        let ctx = cron_ctx("2026-06-11T10:02:00Z", &[("blog/job", utc("2026-06-11T10:00:00Z"))]);
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![]),
            Some(&ctx),
        );
        assert_eq!(types_for(&actions, "blog", "job"), vec!["noop"]);
    }

    #[test]
    fn fires_a_cron_run_when_due() {
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[("blog/job", utc("2026-06-11T10:00:00Z"))]);
        let previous = cron_rep("blog", "job", utc("2026-06-11T10:00:00Z"), "exited", Some(0));
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![previous]),
            Some(&ctx),
        );
        match actions.iter().find(|a| a.type_name() == "cronRun") {
            Some(Action::CronRun { fire_ms, previous, .. }) => {
                assert_eq!(*fire_ms, utc("2026-06-11T10:05:00Z"));
                assert_eq!(previous.len(), 1);
            }
            _ => panic!("expected a cronRun action"),
        }
    }

    #[test]
    fn suppresses_an_overlapping_fire_with_cron_skip() {
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[("blog/job", utc("2026-06-11T10:00:00Z"))]);
        let in_progress = cron_rep("blog", "job", utc("2026-06-11T10:00:00Z"), "running", None);
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![in_progress]),
            Some(&ctx),
        );
        match actions.iter().find(|a| a.type_name() == "cronSkip") {
            Some(Action::CronSkip { fire_ms, .. }) => {
                assert_eq!(*fire_ms, utc("2026-06-11T10:05:00Z"));
            }
            _ => panic!("expected a cronSkip action"),
        }
    }

    #[test]
    fn never_fires_an_unanchored_schedule() {
        // No fire label, no anchor → noop (firing would replay history).
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[]);
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![]),
            Some(&ctx),
        );
        assert_eq!(types_for(&actions, "blog", "job"), vec!["noop"]);
    }

    #[test]
    fn a_running_containers_fire_label_anchors_without_state() {
        // State lost (no anchor) but a run container carries the label → use it.
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[]);
        let finished = cron_rep("blog", "job", utc("2026-06-11T10:00:00Z"), "exited", Some(0));
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![finished]),
            Some(&ctx),
        );
        assert_eq!(types_for(&actions, "blog", "job"), vec!["cronRun"]);
    }

    #[test]
    fn removes_a_stale_long_running_leftover_before_the_run() {
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[("blog/job", utc("2026-06-11T10:00:00Z"))]);
        let leftover = rep("blog", "job", 0, "img:1", "running"); // no fire label
        let actions = plan_reconcile(
            &desired(vec![cron_svc("*/5 * * * *")]),
            &actual_map(vec![leftover]),
            Some(&ctx),
        );
        let names: Vec<&str> = actions.iter().map(|a| a.type_name()).collect();
        let remove_pos = names.iter().position(|n| *n == "remove").expect("remove");
        let run_pos = names.iter().position(|n| *n == "cronRun").expect("cronRun");
        assert!(remove_pos < run_pos, "leftover must be removed before the run");
    }

    #[test]
    fn an_unparseable_expression_is_a_defensive_noop() {
        let ctx = cron_ctx("2026-06-11T10:05:30Z", &[("blog/job", 1)]);
        let actions = plan_reconcile(
            &desired(vec![cron_svc("not a cron")]),
            &actual_map(vec![]),
            Some(&ctx),
        );
        assert_eq!(types_for(&actions, "blog", "job"), vec!["noop"]);
    }

    #[test]
    fn no_cron_context_means_noop() {
        let actions = plan_reconcile(&desired(vec![cron_svc("*/5 * * * *")]), &actual_map(vec![]), None);
        assert_eq!(types_for(&actions, "blog", "job"), vec!["noop"]);
    }

    // ── imperative apply / rollout ──

    use crate::types::{HealthCheck, Ingress};

    /// A `Reconciler` that records the ordered side-effect log and replays a fixed
    /// `wait_healthy` verdict; `fail_pull` / `fail_record_fire` inject failures.
    struct TestReconciler {
        events: Vec<String>,
        errors: BTreeMap<String, String>,
        healthy: bool,
        fail_pull: bool,
        fail_record_fire: bool,
        fail_refresh_routing: bool,
        drain_floor: i64,
    }

    impl TestReconciler {
        fn new() -> Self {
            Self {
                events: Vec::new(),
                errors: BTreeMap::new(),
                healthy: true,
                fail_pull: false,
                fail_record_fire: false,
                fail_refresh_routing: false,
                drain_floor: 0,
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
            cron_fire_ms: Option<i64>,
        ) -> Result<(), String> {
            self.events.push(format!(
                "run {}/{} idx={index} port={host_port:?} bind={bind_host} fire={cron_fire_ms:?}",
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
        fn refresh_routing(&mut self, exclude_ids: &BTreeSet<String>) -> Result<(), String> {
            let ids: Vec<&str> = exclude_ids.iter().map(String::as_str).collect();
            self.events.push(format!("refresh_routing exclude={ids:?}"));
            if self.fail_refresh_routing {
                Err("shard publish failed".into())
            } else {
                Ok(())
            }
        }
        fn drain_floor_ms(&self, _config: &ServiceConfig) -> i64 {
            self.drain_floor
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
        fn record_cron_fire(&mut self, key: &str, fire_ms: i64) -> Result<(), String> {
            self.events.push(format!("record_fire {key}@{fire_ms}"));
            if self.fail_record_fire {
                Err("could not persist the cron fire record — refusing to start the run".into())
            } else {
                Ok(())
            }
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
                edge: "edge-1".into(),
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
    fn rollout_surges_health_gates_then_drains_old_keeping_routing_serving() {
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
                "run blog/api idx=1 port=Some(20001) bind=127.0.0.1 fire=None".to_string(),
                "wait_healthy hp=20001".to_string(),
                // new replica is in the LB BEFORE the old one is touched
                "refresh_routing exclude=[]".to_string(),
                "heartbeat".to_string(),
                "refresh_routing exclude=[\"id-api-0\"]".to_string(),
                "heartbeat".to_string(),
                "sleep 20000".to_string(),
                "stop id-api-0 grace=30".to_string(),
                "release blog/api#0".to_string(),
                "heartbeat".to_string(),
                "refresh_routing exclude=[]".to_string(),
            ]
        );
        assert!(ctx.errors.is_empty());
    }

    #[test]
    fn rollout_drain_wait_is_floored_at_the_edge_propagation_time() {
        let mut ctx = TestReconciler::new();
        ctx.drain_floor = 30_000; // remote edge floor exceeds the 20s drainTimeout
        apply_actions(
            &[Action::Rollout {
                config: svc_web("blog", "api", "img:2", 1),
                replicas: vec![rep("blog", "api", 0, "img:1", "running")],
            }],
            &mut ctx,
        );
        assert!(ctx.events.contains(&"sleep 30000".to_string()));
        assert!(!ctx.events.contains(&"sleep 20000".to_string()));
    }

    #[test]
    fn rollout_aborts_before_stopping_when_the_shard_publish_fails() {
        // Regression guard: a failed mid-rollout routing publish must ABORT the
        // rollout (the error lands on the service) — never proceed to stop an old
        // replica the edge is still routing to.
        let mut ctx = TestReconciler::new();
        ctx.fail_refresh_routing = true;
        apply_actions(
            &[Action::Rollout {
                config: svc_web("blog", "api", "img:2", 1),
                replicas: vec![rep("blog", "api", 0, "img:1", "running")],
            }],
            &mut ctx,
        );
        assert!(!ctx.events.iter().any(|e| e.starts_with("stop ")));
        assert!(!ctx.events.iter().any(|e| e.starts_with("sleep ")));
        assert_eq!(
            ctx.errors.get("blog/api").map(String::as_str),
            Some("shard publish failed")
        );
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
                "run blog/api idx=1 port=Some(20001) bind=127.0.0.1 fire=None".to_string(),
                "wait_healthy hp=20001".to_string(),
                "stop launchpad_blog_api_1 grace=30".to_string(),
                "release blog/api#1".to_string(),
                "refresh_routing exclude=[]".to_string(),
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

    #[test]
    fn cron_run_records_the_fire_before_starting_and_removes_the_previous_run() {
        let mut ctx = TestReconciler::new();
        let fire = utc("2026-06-11T10:05:00Z");
        apply_actions(
            &[Action::CronRun {
                config: cron_svc("*/5 * * * *"),
                fire_ms: fire,
                previous: vec![cron_rep("blog", "job", utc("2026-06-11T10:00:00Z"), "exited", Some(0))],
            }],
            &mut ctx,
        );
        assert_eq!(
            ctx.events,
            vec![
                "pull img:1".to_string(),
                "remove id-job-0".to_string(),
                format!("record_fire blog/job@{fire}"),
                format!("run blog/job idx=0 port=None bind=127.0.0.1 fire=Some({fire})"),
            ]
        );
        assert!(ctx.errors.is_empty());
    }

    #[test]
    fn cron_run_refuses_to_start_when_the_fire_cannot_be_persisted() {
        let mut ctx = TestReconciler::new();
        ctx.fail_record_fire = true;
        apply_actions(
            &[Action::CronRun {
                config: cron_svc("*/5 * * * *"),
                fire_ms: utc("2026-06-11T10:05:00Z"),
                previous: vec![],
            }],
            &mut ctx,
        );
        // The run never started, and the failure surfaced as a service error.
        assert!(!ctx.events.iter().any(|e| e.starts_with("run ")));
        assert!(ctx.errors.contains_key("blog/job"));
    }

    #[test]
    fn cron_skip_records_the_suppressed_fire() {
        let mut ctx = TestReconciler::new();
        let fire = utc("2026-06-11T10:05:00Z");
        apply_actions(
            &[Action::CronSkip {
                config: cron_svc("*/5 * * * *"),
                fire_ms: fire,
            }],
            &mut ctx,
        );
        assert_eq!(ctx.events, vec![format!("record_fire blog/job@{fire}")]);
    }
}
