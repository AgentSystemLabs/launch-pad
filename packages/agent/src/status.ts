import {
  type CaddyStatus,
  type DesiredState,
  type NodeStatus,
  type ServiceState,
  type ServiceStatus,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import type { CaddyOutcome } from "./caddy";
import type { AgentConfig } from "./config";
import type { ManagedContainer } from "./docker";

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

/** Build the NodeStatus to publish after a reconcile pass. */
export function buildStatus(
  config: AgentConfig,
  agentVersion: string,
  desired: DesiredState,
  after: Map<string, ManagedContainer>,
  errors: Map<string, string>,
  caddy: CaddyOutcome,
): NodeStatus {
  const services: ServiceStatus[] = desired.services.map((d) => {
    const key = serviceKey(d.project, d.service);
    const updatedAt = new Date().toISOString();
    const error = errors.get(key);
    if (error) {
      return {
        project: d.project,
        service: d.service,
        image: d.image,
        state: "error",
        message: error,
        containerId: null,
        updatedAt,
      };
    }
    const container = after.get(key);
    if (!container) {
      return {
        project: d.project,
        service: d.service,
        image: d.image,
        state: "pending",
        message: "container not found after reconcile",
        containerId: null,
        updatedAt,
      };
    }
    return {
      project: d.project,
      service: d.service,
      image: container.image,
      state: mapDockerState(container.state),
      message: container.state,
      containerId: container.id,
      updatedAt,
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
    lastSeen: new Date().toISOString(),
    agentVersion,
    services,
    caddy: caddyStatus,
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
  };
}
