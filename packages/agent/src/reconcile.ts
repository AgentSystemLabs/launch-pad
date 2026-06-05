import { setTimeout as sleep } from "node:timers/promises";
import {
  type DesiredState,
  parseDurationMs,
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
    replica.memory !== config.memory
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
  /** Rebuild + push Caddy from live replicas, excluding the given container ids. */
  refreshCaddy: (excludeIds?: Set<string>) => Promise<void>;
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
 * ≥1 healthy upstream for the domain, so there is no downtime.
 */
async function rolloutService(
  c: ServiceConfig,
  current: ManagedReplica[],
  ctx: ApplyContext,
): Promise<void> {
  const key = serviceKey(c.project, c.service);
  const want = c.replicas;
  const surge = c.rollout.maxSurge;
  const drainMs = parseDurationMs(c.rollout.drainTimeout);
  const graceSec = Math.max(1, Math.ceil(parseDurationMs(c.rollout.stopGrace) / 1000));
  const hc = c.healthCheck;
  const hasIngress = c.ingress != null;

  await pull(c.image);

  const oldQueue = current.filter((r) => replicaNeedsReplace(r, c));
  let newCount = current.filter((r) => !replicaNeedsReplace(r, c)).length;
  let nextIndex = current.reduce((m, r) => Math.max(m, r.index), -1) + 1;
  const draining = new Set<string>();

  for (;;) {
    const total = oldQueue.length + newCount;
    if (newCount < want && total < want + surge) {
      // Surge a new replica.
      const idx = nextIndex;
      nextIndex += 1;
      const hostPort = hasIngress ? ctx.port(key, idx) : undefined;
      await runContainer({ config: c, index: idx, hostPort, bindHost: ctx.bindHost(c) });

      if (hc && hostPort !== undefined) {
        const ceiling = Math.max(30_000, (hc.timeoutMs + hc.intervalMs) * hc.healthyThreshold * 8);
        if (!(await waitHealthy(hostPort, hc, ceiling))) {
          await stopContainer(containerName(c.project, c.service, idx), graceSec);
          ctx.releasePort(key, idx);
          ctx.errors.set(key, `rollout aborted: new replica failed health check for ${c.image}`);
          if (hasIngress) await ctx.refreshCaddy(draining);
          return;
        }
      }
      newCount += 1;
      if (hasIngress) {
        await ctx.refreshCaddy(draining);
        await ctx.heartbeat();
      }
    } else if (oldQueue.length > 0) {
      // Drain + graceful-stop one old replica.
      const old = oldQueue.shift() as ManagedReplica;
      if (hasIngress) {
        draining.add(old.id);
        await ctx.refreshCaddy(draining); // stop routing to it BEFORE stopping it
        await ctx.heartbeat();
        if (drainMs > 0) await sleep(drainMs);
      }
      await stopContainer(old.id, graceSec);
      draining.delete(old.id);
      ctx.releasePort(key, old.index);
      await ctx.heartbeat();
    } else {
      break;
    }
  }

  if (hasIngress) await ctx.refreshCaddy();
}

export { containerName };
