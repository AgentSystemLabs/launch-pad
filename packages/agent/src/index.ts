import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_POLL_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  LIVENESS_HEARTBEAT_MS,
  type NodeStatus,
  type ServiceConfig,
  STATS_DEFAULT_INTERVAL_MS,
} from "@agentsystemlabs/launch-pad-shared";
import { makeClients } from "./aws";
import { applyCaddy, type CaddyOutcome, type WebRoute } from "./caddy";
import { createCloudWatchAgentSync } from "./cloudwatch-logs";
import { loadAgentConfig } from "./config";
import { inspectManaged } from "./docker";
import { ensureEcrLogin } from "./ecr-auth";
import { edgeTick } from "./edge";
import { getPrivateIp } from "./metadata";
import { applyActions, planReconcile } from "./reconcile";
import {
  buildCoLocatedRoutes,
  buildShardRoutes,
  isCoLocatedIngress,
  mergeRoutesByDomain,
} from "./routes";
import {
  getDesired,
  listUpstreamShards,
  putStatus,
  putUpstreamShard,
  type ShardListCache,
} from "./s3";
import { allocatePort, loadState, releasePort, saveState } from "./state";
import { createStatsSampler, cpuSharesByKey } from "./stats";
import { buildStatus, heartbeatStatus } from "./status";
import { createStatusWriter, fingerprintShard, resolveLiveness } from "./status-write";
import { buildUpstreamShards } from "./upstream";

const AGENT_VERSION = process.env.LAUNCHPAD_AGENT_VERSION ?? "0.0.0";
const NO_CADDY: CaddyOutcome = { managed: false, lastReloadAt: null, error: null };

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const { s3, ecr } = makeClients(config.region);
  const state = loadState();

  const intervalMs = Number(process.env.LAUNCHPAD_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const once = process.env.LAUNCHPAD_ONCE === "1";
  const debugS3 = process.env.LAUNCHPAD_DEBUG_S3 === "1";

  // Write-on-change publishing: status.json is only PUT when its meaningful content
  // changes, with a periodic liveness heartbeat so the CLI's staleness check stays
  // reliable. Liveness can only fire on a tick, so it's clamped against the stale window.
  const { livenessMs, warnings } = resolveLiveness({
    livenessMs: Number(process.env.LAUNCHPAD_LIVENESS_MS ?? LIVENESS_HEARTBEAT_MS),
    pollMs: intervalMs,
    staleMs: HEARTBEAT_STALE_MS,
  });
  for (const w of warnings) console.error(`[agent] liveness: ${w}`);

  const writer = createStatusWriter(livenessMs);
  const putFn = (status: NodeStatus): Promise<void> =>
    putStatus(s3, config.bucket, config.clusterId, status);

  // Ships app stdout/stderr (and this node's agent/caddy journald) to CloudWatch Logs
  // via the on-box CloudWatch Agent. Reconciled after each tick; degraded-safe (a
  // missing/broken CloudWatch Agent never breaks Docker/Caddy reconcile).
  const cloudwatch = createCloudWatchAgentSync({
    clusterId: config.clusterId,
    nodeId: config.nodeId,
    role: config.role,
  });
  const syncCloudWatch = async (replicas: Awaited<ReturnType<typeof inspectManaged>> | null): Promise<void> => {
    try {
      const live = replicas ?? (await inspectManaged());
      await cloudwatch.sync([...live.values()].flat());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent] cloudwatch: ${message}`);
    }
  };
  // Periodic resource-usage sampler: emits one `launchpad.stats` JSON line to stderr
  // every interval, which the system-log pipeline ships to CloudWatch for history
  // (`launch-pad node monitor --since`). Degraded-safe — never breaks a reconcile.
  const stats = createStatsSampler({
    nodeId: config.nodeId,
    intervalMs: Number(process.env.LAUNCHPAD_STATS_INTERVAL_MS ?? STATS_DEFAULT_INTERVAL_MS),
    includeServices: process.env.LAUNCHPAD_STATS_SERVICES !== "0",
  });

  // Per-edge fingerprint of the last upstream shard we published (write-on-change).
  const lastShardFingerprints = new Map<string, string>();
  // Listing cache so a stable edge / `both` node skips redundant per-shard GETs.
  const shardCache: ShardListCache = { fingerprint: null, shards: [] };

  const port = (key: string, index: number): number => {
    const p = allocatePort(state, key, index);
    saveState(state);
    return p;
  };
  const releasePortFn = (key: string, index: number): void => {
    releasePort(state, key, index);
    saveState(state);
  };
  const bindHost = (c: ServiceConfig): string => (c.ingress?.edge ? "0.0.0.0" : "127.0.0.1");

  async function tick(): Promise<void> {
    try {
      if (config.role === "edge") {
        const status = await edgeTick(config, s3, AGENT_VERSION, shardCache);
        const reason = await writer.maybeWrite(status, Date.now(), putFn);
        if (debugS3) console.error(`[agent] s3: status ${reason}`);
        // Edge ships system logs only (agent + caddy) — no containers run here.
        await syncCloudWatch(new Map());
        // Host-only usage sample (no managed containers on an edge).
        await stats.maybeSample(Date.now(), new Map());
        return;
      }

      const desired = await getDesired(s3, config.bucket, config.clusterId, config.nodeId);
      if (desired.services.length > 0) {
        await ensureEcrLogin(ecr);
      }

      // Web services whose Caddy is co-located on THIS node (edge null or points to self).
      const hasCoLocatedWeb = desired.services.some(
        (s) => s.ingress && isCoLocatedIngress(config.nodeId, s.ingress.edge),
      );
      const frontsRemoteApps = config.role === "both";
      let caddyOutcome: CaddyOutcome = NO_CADDY;
      const errors = new Map<string, string>();

      const buildCaddyRoutes = async (excludeIds: Set<string> = new Set()): Promise<WebRoute[]> => {
        const live = await inspectManaged();
        const routes = buildCoLocatedRoutes(config.nodeId, desired, live, excludeIds);
        if (frontsRemoteApps) {
          const shards = await listUpstreamShards(
            s3,
            config.bucket,
            config.clusterId,
            config.nodeId,
            shardCache,
          );
          routes.push(...buildShardRoutes(shards));
        }
        return mergeRoutesByDomain(routes);
      };

      // Rebuild Caddy from co-located replicas + (for both) remote upstream shards.
      const refreshCaddy = async (excludeIds: Set<string> = new Set()): Promise<void> => {
        if (!hasCoLocatedWeb && !frontsRemoteApps) {
          caddyOutcome = NO_CADDY;
          return;
        }
        const routes = await buildCaddyRoutes(excludeIds);
        if (routes.length === 0 && !hasCoLocatedWeb && !frontsRemoteApps) {
          caddyOutcome = NO_CADDY;
          return;
        }
        caddyOutcome = await applyCaddy(routes);
      };

      const currentStatus = async (): Promise<NodeStatus> => {
        const live = await inspectManaged();
        return buildStatus(config, AGENT_VERSION, desired, live, errors, caddyOutcome);
      };

      // Mid-rollout heartbeat: always writes (keeps status fresh during long drains),
      // same as before the write-on-change change.
      const heartbeat = async (): Promise<void> => {
        await writer.forceWrite(await currentStatus(), Date.now(), putFn);
        if (debugS3) console.error("[agent] s3: status PUT (rollout heartbeat)");
      };

      const publishUpstream = async (): Promise<void> => {
        const live = await inspectManaged();
        const privateIp = await getPrivateIp();
        const shards = buildUpstreamShards(config.nodeId, privateIp, desired, live);
        for (const [edgeId, shard] of shards) {
          // Co-located edge (self) is programmed via local Caddy, not S3 shards.
          if (edgeId === config.nodeId) continue;
          // Write-on-change: only re-publish when routing-relevant fields moved.
          const fp = fingerprintShard(shard);
          if (lastShardFingerprints.get(edgeId) === fp) {
            if (debugS3) console.error(`[agent] s3: upstream ${edgeId} skip`);
            continue;
          }
          await putUpstreamShard(s3, config.bucket, config.clusterId, edgeId, config.nodeId, shard);
          lastShardFingerprints.set(edgeId, fp);
          if (debugS3) console.error(`[agent] s3: upstream ${edgeId} PUT`);
        }
      };

      const before = await inspectManaged();
      const actions = planReconcile(desired, before);
      await applyActions(actions, {
        bindHost,
        port,
        releasePort: releasePortFn,
        refreshCaddy,
        heartbeat,
        errors,
      });

      await refreshCaddy();
      const reason = await writer.maybeWrite(await currentStatus(), Date.now(), putFn);
      if (debugS3) console.error(`[agent] s3: status ${reason}`);
      if (desired.services.some((s) => s.ingress?.edge && s.ingress.edge !== config.nodeId)) {
        await publishUpstream();
      }
      // Reconcile CloudWatch log shipping to the containers now running on this node.
      await syncCloudWatch(null);
      // Sample host + per-container usage (CPU normalized to each service's cpu limit).
      await stats.maybeSample(Date.now(), cpuSharesByKey(desired.services));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent] reconcile error: ${message}`);
      try {
        // Whole-tick failure: always publish the error status (and refresh the tracker
        // so recovery is detected as a change next tick).
        await writer.forceWrite(heartbeatStatus(config, AGENT_VERSION, message), Date.now(), putFn);
      } catch {
        /* best effort — the next tick retries */
      }
    }
  }

  console.error(
    `[agent] starting for node ${config.nodeId} role=${config.role} (bucket ${config.bucket}) ` +
      `poll=${intervalMs}ms liveness=${livenessMs}ms`,
  );

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await tick();
  if (once) return;

  while (running) {
    await sleep(intervalMs);
    if (!running) break;
    await tick();
  }
}

main().catch((error) => {
  console.error("[agent] fatal:", error);
  process.exitCode = 1;
});
