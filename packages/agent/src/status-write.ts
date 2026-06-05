import { createHash } from "node:crypto";
import type { NodeStatus, UpstreamShard } from "@agentsystemlabs/launch-pad-shared";

/** Recursively sort object keys so structurally-equal values serialize byte-identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonical(src[key]);
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a NodeStatus over only its *meaningful* fields, dropping the ones that exist
 * solely to signal time (`lastSeen`, per-service `updatedAt`, `caddy.lastReloadAt`).
 * Two idle ticks therefore fingerprint identically, while a replica/image/state/error
 * change flips the hash. Services, replicas and edge routes are sorted so a different
 * listing order from Docker/S3 can't perturb the result.
 */
export function fingerprintStatus(status: NodeStatus): string {
  const services = [...status.services]
    .sort((a, b) => `${a.project}/${a.service}`.localeCompare(`${b.project}/${b.service}`))
    .map((s) => ({
      project: s.project,
      service: s.service,
      image: s.image,
      state: s.state,
      message: s.message,
      containerId: s.containerId,
      desiredReplicas: s.desiredReplicas,
      runningReplicas: s.runningReplicas,
      replicas: [...s.replicas]
        .sort((a, b) => a.index - b.index)
        .map((r) => ({
          index: r.index,
          containerId: r.containerId,
          hostPort: r.hostPort,
          state: r.state,
          image: r.image,
          healthy: r.healthy,
        })),
    }));
  const edgeRoutes = [...status.edgeRoutes].sort((a, b) => a.domain.localeCompare(b.domain));
  const payload = {
    nodeId: status.nodeId,
    agentId: status.agentId,
    agentVersion: status.agentVersion,
    // caddy.lastReloadAt is a timestamp; managed/error are the meaningful bits.
    caddy: { managed: status.caddy.managed, error: status.caddy.error },
    services,
    edgeRoutes,
  };
  return sha256Hex(JSON.stringify(canonical(payload)));
}

/** Hash an UpstreamShard over its routing-relevant fields only (drops `updatedAt`). */
export function fingerprintShard(shard: UpstreamShard): string {
  const backends = [...shard.backends].sort((a, b) =>
    `${a.domain}:${a.hostPort}`.localeCompare(`${b.domain}:${b.hostPort}`),
  );
  const payload = { nodeId: shard.nodeId, privateIp: shard.privateIp, backends };
  return sha256Hex(JSON.stringify(canonical(payload)));
}

export type WriteReason = "first" | "changed" | "liveness" | "skip";

export interface WriteTracker {
  /** Fingerprint of the last status written, or null before the first write. */
  fingerprint: string | null;
  /** Wall-clock ms of the last write. */
  lastWriteMs: number;
}

/**
 * Decide whether to publish status given the prior write: always on the first tick
 * or a real change, otherwise only when the liveness heartbeat is due.
 */
export function decideStatusWrite(
  prev: WriteTracker,
  fingerprint: string,
  nowMs: number,
  livenessMs: number,
): { write: boolean; reason: WriteReason } {
  if (prev.fingerprint === null) return { write: true, reason: "first" };
  if (prev.fingerprint !== fingerprint) return { write: true, reason: "changed" };
  if (nowMs - prev.lastWriteMs >= livenessMs) return { write: true, reason: "liveness" };
  return { write: false, reason: "skip" };
}

export interface StatusWriter {
  /** Conditionally PUT status — writes on first tick / change / liveness-due, else skips. */
  maybeWrite(
    status: NodeStatus,
    nowMs: number,
    put: (status: NodeStatus) => Promise<void>,
  ): Promise<WriteReason>;
  /** Unconditional PUT (mid-rollout heartbeat / error path) that still refreshes the tracker. */
  forceWrite(
    status: NodeStatus,
    nowMs: number,
    put: (status: NodeStatus) => Promise<void>,
  ): Promise<void>;
}

/** A stateful status publisher holding the in-memory write tracker for one process. */
export function createStatusWriter(livenessMs: number): StatusWriter {
  const prev: WriteTracker = { fingerprint: null, lastWriteMs: 0 };
  return {
    async maybeWrite(status, nowMs, put) {
      const fingerprint = fingerprintStatus(status);
      const { write, reason } = decideStatusWrite(prev, fingerprint, nowMs, livenessMs);
      if (write) {
        await put(status);
        prev.fingerprint = fingerprint;
        prev.lastWriteMs = nowMs;
      }
      return reason;
    },
    async forceWrite(status, nowMs, put) {
      await put(status);
      prev.fingerprint = fingerprintStatus(status);
      prev.lastWriteMs = nowMs;
    },
  };
}

/**
 * Resolve the effective liveness interval, clamping it under the stale window and
 * surfacing warnings the agent logs at startup. Liveness can only fire on a tick, so
 * a poll interval at/above the stale window is also called out (it can't be fixed by
 * the liveness setting — the operator must lower LAUNCHPAD_POLL_MS).
 */
export function resolveLiveness(opts: {
  livenessMs: number;
  pollMs: number;
  staleMs: number;
}): { livenessMs: number; warnings: string[] } {
  const warnings: string[] = [];
  const maxSafe = Math.floor(opts.staleMs / 2);
  let livenessMs = opts.livenessMs;

  if (!Number.isFinite(livenessMs) || livenessMs <= 0) {
    warnings.push(`invalid liveness ${opts.livenessMs}; using ${maxSafe}ms`);
    livenessMs = maxSafe;
  } else if (livenessMs > maxSafe) {
    warnings.push(
      `liveness ${livenessMs}ms exceeds half the ${opts.staleMs}ms stale window; clamping to ${maxSafe}ms`,
    );
    livenessMs = maxSafe;
  }

  if (opts.pollMs >= opts.staleMs) {
    warnings.push(
      `poll ${opts.pollMs}ms >= ${opts.staleMs}ms stale window — liveness only fires per tick, so the node may read stale between ticks; lower LAUNCHPAD_POLL_MS`,
    );
  }

  return { livenessMs, warnings };
}
