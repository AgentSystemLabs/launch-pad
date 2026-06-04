import { type DesiredState, type ServiceConfig, serviceKey } from "@agentsystemlabs/launch-pad-shared";
import {
  containerName,
  type ManagedContainer,
  pull,
  removeContainer,
  runContainer,
  startContainer,
} from "./docker";

export type Action =
  | { type: "create"; config: ServiceConfig }
  | { type: "replace"; config: ServiceConfig; name: string }
  | { type: "start"; config: ServiceConfig; name: string }
  | { type: "noop"; config: ServiceConfig }
  | { type: "remove"; name: string; key: string };

/**
 * Pure diff: given the desired state and the containers that actually exist,
 * decide what to do. No side effects — easy to unit test.
 */
export function planReconcile(
  desired: DesiredState,
  actual: Map<string, ManagedContainer>,
): Action[] {
  const actions: Action[] = [];
  const desiredKeys = new Set<string>();

  for (const config of desired.services) {
    const key = serviceKey(config.project, config.service);
    desiredKeys.add(key);
    const existing = actual.get(key);

    if (!existing) {
      actions.push({ type: "create", config });
    } else if (existing.image !== config.image) {
      actions.push({ type: "replace", config, name: existing.name });
    } else if (existing.state !== "running") {
      actions.push({ type: "start", config, name: existing.name });
    } else {
      actions.push({ type: "noop", config });
    }
  }

  for (const [key, container] of actual) {
    if (!desiredKeys.has(key)) {
      actions.push({ type: "remove", name: container.name, key });
    }
  }

  return actions;
}

export interface ApplyContext {
  /** Resolve the host port for a (web) service; undefined for workers. */
  port: (config: ServiceConfig) => number | undefined;
  /** Populated with per-service error messages (keyed project/service). */
  errors: Map<string, string>;
}

/** Execute a plan. Per-service failures are recorded in ctx.errors, not thrown. */
export async function applyActions(actions: Action[], ctx: ApplyContext): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.type) {
        case "remove":
          await removeContainer(action.name);
          break;
        case "noop":
          break;
        case "start":
          await startContainer(action.name);
          break;
        case "create":
          await pull(action.config.image);
          await runContainer({ config: action.config, hostPort: ctx.port(action.config) });
          break;
        case "replace":
          await removeContainer(action.name);
          await pull(action.config.image);
          await runContainer({ config: action.config, hostPort: ctx.port(action.config) });
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

// Re-exported for callers that need the canonical container name.
export { containerName };
