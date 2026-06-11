import { setTimeout as sleep } from "node:timers/promises";
import {
  type DesiredState,
  parseDurationMs,
  serviceConfigStamp,
  type ServiceConfig,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import {
  containerName,
  type ManagedReplica,
  pull,
  removeContainer,
  runContainer,
  startContainer,
  stopContainer,
} from "./docker";
import { waitHealthy } from "./health";

/**
 * Floor on how long a rollout waits for a freshly-surged replica to pass its
 * health check before aborting — even a service with very tight probe timings
 * gets at least this long to cold-start.
 */
const MIN_HEALTH_CEILING_MS = 30_000;

/**
 * How many full health-check cycles (timeout+interval, repeated `healthyThreshold`
 * times) a surged replica is allowed before the rollout gives up. 8× is generous
 * slack so a slow cold start isn't mistaken for a failed deploy.
 */
const HEALTH_CEILING_CYCLES = 8;

export type Action =
  | { type: "create"; config: ServiceConfig; index: number }
  | { type: "start"; config: ServiceConfig; index: number; id: string }
  | { type: "scaleDown"; config: ServiceConfig; remove: ManagedReplica[] }
  | { type: "rollout"; config: ServiceConfig; replicas: ManagedReplica[] }
  | { type: "remove"; key: string; replicas: ManagedReplica[] }
  | { type: "noop"; config: ServiceConfig };

/** True when a live replica must be replaced to match desired (image or resources). */
export function replicaNeedsReplace(replica: ManagedReplica, config: ServiceConfig): boolean {
  return (
    replica.image !== config.image ||
    replica.cpu !== config.cpu ||
    replica.memory !== config.memory ||
    replica.configStamp !== serviceConfigStamp(config)
  );
}

/**
 * Pure diff over the replica set. Reasons by COUNT (not fixed indices) so a service
 * whose replicas live at non-`0..N-1` indices (after a rollout) is still "converged".
 * Image or cpu/memory drift collapses to a single `rollout` action handled imperatively in apply.
 */
export function planReconcile(
  desired: DesiredState,
  actual: Map<string, ManagedReplica[]>,
): Action[] {
  const actions: Action[] = [];
  const desiredKeys = new Set<string>();

  for (const c of desired.services) {
    const key = serviceKey(c.project, c.service);
    desiredKeys.add(key);
    const have = actual.get(key) ?? [];

    if (have.some((r) => replicaNeedsReplace(r, c))) {
      actions.push({ type: "rollout", config: c, replicas: have });
      continue;
    }

    // A `start` is a bare `docker start` of the EXISTING container, so it's only
    // safe because the `replicaNeedsReplace` branch above already short-circuited
    // (via `continue`) any replica whose image/cpu/memory drifted — a stopped
    // replica that reaches here is guaranteed to still match desired. Do not move
    // this branch above the replace check or a `start` could resurrect a stale
    // container.
    const stopped = have.filter((r) => r.state !== "running");
    for (const r of stopped) {
      actions.push({ type: "start", config: c, index: r.index, id: r.id });
    }

    if (have.length < c.replicas) {
      const used = new Set(have.map((r) => r.index));
      let idx = 0;
      for (let k = have.length; k < c.replicas; k += 1) {
        while (used.has(idx)) idx += 1;
        used.add(idx);
        actions.push({ type: "create", config: c, index: idx });
        idx += 1;
      }
    } else if (have.length > c.replicas) {
      const extras = [...have]
        .sort((a, b) => b.index - a.index)
        .slice(0, have.length - c.replicas);
      actions.push({ type: "scaleDown", config: c, remove: extras });
    } else if (stopped.length === 0) {
      actions.push({ type: "noop", config: c });
    }
  }

  for (const [key, replicas] of actual) {
    if (!desiredKeys.has(key)) {
      actions.push({ type: "remove", key, replicas });
    }
  }

  return actions;
}

export interface ApplyContext {
  /** "127.0.0.1" (co-located) or "0.0.0.0" (remote edge) for a service. */
  bindHost: (config: ServiceConfig) => string;
  /** Allocate the stable host port for (service key, replica index). */
  port: (key: string, index: number) => number;
  releasePort: (key: string, index: number) => void;
  /**
   * Rebuild + push ROUTING from live replicas, excluding the given container ids:
   * the local Caddy config (co-located web) AND/OR the upstream shards published
   * to remote edge nodes. Both must happen here — mid-rollout, not at tick end —
   * or a remote edge keeps routing to replicas the rollout already stopped.
   */
  refreshRouting: (excludeIds?: Set<string>) => Promise<void>;
  /**
   * Floor on the drain wait before stopping an old replica. For a service fronted
   * by a REMOTE edge the routing update is asynchronous (S3 shard → edge poll →
   * Caddy reload), so the wait must cover that propagation even when the user's
   * drainTimeout is shorter. Co-located ingress reloads Caddy synchronously → 0.
   */
  drainFloorMs: (config: ServiceConfig) => number;
  /** Re-write status.json (keeps the heartbeat fresh during long rollouts). */
  heartbeat: () => Promise<void>;
  errors: Map<string, string>;
}

export async function applyActions(actions: Action[], ctx: ApplyContext): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "noop":
          break;
        case "remove":
          for (const r of action.replicas) await removeContainer(r.id);
          break;
        case "scaleDown":
          for (const r of action.remove) {
            await removeContainer(r.id);
            ctx.releasePort(serviceKey(action.config.project, action.config.service), r.index);
          }
          break;
        case "start":
          await startContainer(action.id);
          break;
        case "create": {
          const c = action.config;
          const key = serviceKey(c.project, c.service);
          await pull(c.image);
          const hostPort = c.ingress ? ctx.port(key, action.index) : undefined;
          await runContainer({ config: c, index: action.index, hostPort, bindHost: ctx.bindHost(c) });
          break;
        }
        case "rollout":
          await rolloutService(action.config, action.replicas, ctx);
          break;
      }
    } catch (error) {
      // Per-action failures are intentionally ISOLATED: record the error against
      // the service (it surfaces in the service's status message) and keep going,
      // so one bad service — a failed pull, an unschedulable container — can't
      // wedge reconciliation for every other service. The next tick retries this
      // action from scratch, which is why the loop is crash-safe. Never rethrow
      // here.
      if ("config" in action) {
        ctx.errors.set(
          serviceKey(action.config.project, action.config.service),
          (error as Error).message,
        );
      }
    }
  }
}

/**
 * Health-gated rolling update: surge a new replica → wait healthy → add to the LB →
 * remove one old from the LB → drain → graceful stop. Invariant: Caddy always has
 * ≥1 healthy upstream for the domain, so there is no downtime. "The LB" may live on
 * a remote edge node — every refreshRouting call re-publishes this node's upstream
 * shards too, and the drain wait is floored at the edge's propagation time, so the
 * invariant holds across the S3 → edge-poll → Caddy-reload hop.
 */
async function rolloutService(
  config: ServiceConfig,
  current: ManagedReplica[],
  ctx: ApplyContext,
): Promise<void> {
  const key = serviceKey(config.project, config.service);
  const want = config.replicas;
  const surge = config.rollout.maxSurge;
  const drainMs = parseDurationMs(config.rollout.drainTimeout);
  const graceSec = Math.max(1, Math.ceil(parseDurationMs(config.rollout.stopGrace) / 1000));
  const healthCheck = config.healthCheck;
  const hasIngress = config.ingress != null;

  await pull(config.image);

  const oldQueue = current.filter((r) => replicaNeedsReplace(r, config));
  let newCount = current.filter((r) => !replicaNeedsReplace(r, config)).length;
  let nextIndex = current.reduce((m, r) => Math.max(m, r.index), -1) + 1;
  const draining = new Set<string>();

  // Hand-rolled state machine with three branches, run until convergence:
  //   1. surge   — too few new replicas and headroom under want+surge → start one
  //   2. drain   — new replicas satisfied but old ones remain → retire one old
  //   3. break   — no old left and new count met → done
  // Termination: every surge increments newCount (or returns on health failure)
  // and every drain shrinks oldQueue, so `oldQueue.length + newCount` strictly
  // progresses toward `want` — the loop cannot spin forever.
  for (;;) {
    const total = oldQueue.length + newCount;
    if (newCount < want && total < want + surge) {
      // Branch 1: surge a new replica.
      const idx = nextIndex;
      nextIndex += 1;
      const hostPort = hasIngress ? ctx.port(key, idx) : undefined;
      await runContainer({ config, index: idx, hostPort, bindHost: ctx.bindHost(config) });

      if (healthCheck && hostPort !== undefined) {
        const ceiling = Math.max(
          MIN_HEALTH_CEILING_MS,
          (healthCheck.timeoutMs + healthCheck.intervalMs) *
            healthCheck.healthyThreshold *
            HEALTH_CEILING_CYCLES,
        );
        if (!(await waitHealthy(hostPort, healthCheck, ceiling))) {
          await stopContainer(containerName(config.project, config.service, idx), graceSec);
          ctx.releasePort(key, idx);
          ctx.errors.set(
            key,
            `rollout aborted: new replica failed health check for ${config.image}`,
          );
          if (hasIngress) await ctx.refreshRouting(draining);
          return;
        }
      }
      newCount += 1;
      if (hasIngress) {
        await ctx.refreshRouting(draining);
        await ctx.heartbeat();
      }
    } else if (oldQueue.length > 0) {
      // Branch 2: drain + graceful-stop one old replica.
      const old = oldQueue.shift() as ManagedReplica;
      if (hasIngress) {
        draining.add(old.id);
        await ctx.refreshRouting(draining); // stop routing to it BEFORE stopping it
        await ctx.heartbeat();
        // The wait must outlast routing propagation (see drainFloorMs) or the
        // stop below kills a replica the edge is still sending requests to.
        const waitMs = Math.max(drainMs, ctx.drainFloorMs(config));
        if (waitMs > 0) await sleep(waitMs);
      }
      await stopContainer(old.id, graceSec);
      draining.delete(old.id);
      ctx.releasePort(key, old.index);
      await ctx.heartbeat();
    } else {
      break;
    }
  }

  if (hasIngress) await ctx.refreshRouting();
}

export { containerName };
