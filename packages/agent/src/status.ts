import {
  type CaddyStatus,
  type DesiredState,
  type NodeStatus,
  type ReplicaStatus,
  type ServiceState,
  type ServiceStatus,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import type { CaddyOutcome } from "./caddy";
import type { AgentConfig } from "./config";
import type { ManagedReplica } from "./docker";

function mapDockerState(state: string): ServiceState {
  switch (state) {
    case "running":
      return "running";
    case "exited":
    case "dead":
      return "stopped";
    case "created":
    case "restarting":
      return "starting";
    default:
      return "pending";
  }
}

/** Roll a service's replica states up into a single state for the watcher/back-compat. */
function rollupState(
  replicas: ReplicaStatus[],
  desiredReplicas: number,
  hasError: boolean,
): ServiceState {
  if (hasError) return "error";
  const running = replicas.filter((r) => r.state === "running").length;
  if (running >= desiredReplicas && desiredReplicas > 0) return "running";
  if (running > 0) return "starting";
  if (replicas.length > 0) return replicas[0]?.state ?? "pending";
  return "pending";
}

/** Build the NodeStatus to publish after a reconcile pass. */
export function buildStatus(
  config: AgentConfig,
  agentVersion: string,
  desired: DesiredState,
  live: Map<string, ManagedReplica[]>,
  errors: Map<string, string>,
  caddy: CaddyOutcome,
): NodeStatus {
  const now = new Date().toISOString();

  const services: ServiceStatus[] = desired.services.map((d) => {
    const key = serviceKey(d.project, d.service);
    const reps = live.get(key) ?? [];
    const error = errors.get(key);

    const replicas: ReplicaStatus[] = reps.map((r) => {
      const state = mapDockerState(r.state);
      return {
        index: r.index,
        containerId: r.id,
        hostPort: r.hostPort,
        state,
        image: r.image,
        // NOTE: this mirrors RUNNING state, not the active health-probe result —
        // a container can be running while still failing its health check. The
        // edge only routes to replicas the agent already health-gated into the LB
        // during rollout, so "running" is a sufficient signal here; rename/wire in
        // the real probe result if that ever stops being true.
        healthy: state === "running",
      };
    });

    const running = replicas.filter((r) => r.state === "running");
    const state = rollupState(replicas, d.replicas, error !== undefined);

    return {
      project: d.project,
      service: d.service,
      image: running[0]?.image ?? d.image,
      state,
      message: error ?? state,
      containerId: running[0]?.containerId ?? null,
      replicas,
      desiredReplicas: d.replicas,
      runningReplicas: running.length,
      updatedAt: now,
    };
  });

  const caddyStatus: CaddyStatus = {
    managed: caddy.managed,
    lastReloadAt: caddy.lastReloadAt,
    error: caddy.error,
  };

  return {
    nodeId: config.nodeId,
    agentId: config.agentId,
    lastSeen: now,
    agentVersion,
    services,
    caddy: caddyStatus,
    edgeRoutes: [],
  };
}

/** A minimal heartbeat status used when a whole reconcile pass throws. */
export function heartbeatStatus(
  config: AgentConfig,
  agentVersion: string,
  message: string,
): NodeStatus {
  return {
    nodeId: config.nodeId,
    agentId: config.agentId,
    lastSeen: new Date().toISOString(),
    agentVersion,
    services: [],
    caddy: { managed: false, lastReloadAt: null, error: message },
    edgeRoutes: [],
  };
}
