import { setTimeout as sleep } from "node:timers/promises";
import type { HealthCheck } from "@agentsystemlabs/launch-pad-shared";

/** Single HTTP probe against a replica's published host port. */
export async function probeHealth(hostPort: number, path: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${hostPort}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll a replica until it passes `healthyThreshold` consecutive probes, or the ceiling elapses. */
export async function waitHealthy(hostPort: number, hc: HealthCheck, ceilingMs: number): Promise<boolean> {
  const deadline = Date.now() + ceilingMs;
  let consecutive = 0;
  for (;;) {
    if (await probeHealth(hostPort, hc.path, hc.timeoutMs)) {
      consecutive += 1;
      if (consecutive >= hc.healthyThreshold) return true;
    } else {
      consecutive = 0;
    }
    if (Date.now() >= deadline) return false;
    await sleep(hc.intervalMs);
  }
}
