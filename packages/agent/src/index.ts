import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_POLL_INTERVAL_MS, type ServiceConfig, serviceKey } from "@agentsystemlabs/launch-pad-shared";
import { makeClients } from "./aws";
import { applyCaddy } from "./caddy";
import { loadAgentConfig } from "./config";
import { inspectManaged } from "./docker";
import { ensureEcrLogin } from "./ecr-auth";
import { applyActions, planReconcile } from "./reconcile";
import { getDesired, putStatus } from "./s3";
import { allocatePort, loadState, saveState } from "./state";
import { buildStatus, heartbeatStatus } from "./status";

const AGENT_VERSION = process.env.LAUNCHPAD_AGENT_VERSION ?? "0.0.0";

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const { s3, ecr } = makeClients(config.region);
  const state = loadState();

  const intervalMs = Number(process.env.LAUNCHPAD_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const once = process.env.LAUNCHPAD_ONCE === "1";

  async function tick(): Promise<void> {
    try {
      const desired = await getDesired(s3, config.bucket, config.nodeId);
      if (desired.services.length > 0) {
        await ensureEcrLogin(ecr);
      }

      // Allocate a stable host port for every web service up front, so the
      // container binding and the Caddy upstream agree.
      const portMap = new Map<string, number>();
      for (const s of desired.services) {
        if (s.ingress) {
          portMap.set(serviceKey(s.project, s.service), allocatePort(state, serviceKey(s.project, s.service)));
        }
      }
      saveState(state);
      const port = (c: ServiceConfig): number | undefined =>
        c.ingress ? portMap.get(serviceKey(c.project, c.service)) : undefined;

      const before = await inspectManaged();
      const actions = planReconcile(desired, before);
      const errors = new Map<string, string>();
      await applyActions(actions, { port, errors });
      const after = await inspectManaged();

      // Point Caddy at the web services (auto-HTTPS); workers contribute nothing.
      const webRoutes = desired.services
        .filter((s) => s.ingress)
        .map((s) => ({
          domain: (s.ingress as { domain: string }).domain,
          hostPort: portMap.get(serviceKey(s.project, s.service)) as number,
        }));
      const caddy =
        webRoutes.length > 0
          ? await applyCaddy(webRoutes)
          : { managed: false, lastReloadAt: null, error: null };

      await putStatus(
        s3,
        config.bucket,
        buildStatus(config, AGENT_VERSION, desired, after, errors, caddy),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent] reconcile error: ${message}`);
      try {
        await putStatus(s3, config.bucket, heartbeatStatus(config, AGENT_VERSION, message));
      } catch {
        /* best effort — if even the heartbeat write fails, the next tick retries */
      }
    }
  }

  console.error(`[agent] starting for node ${config.nodeId} (bucket ${config.bucket})`);

  // Single-flight loop: each tick fully completes before the next begins.
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
