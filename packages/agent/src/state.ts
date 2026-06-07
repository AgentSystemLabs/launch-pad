import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOST_PORT_COUNT, HOST_PORT_MIN } from "@agentsystemlabs/launch-pad-shared";

const STATE_PATH = process.env.LAUNCHPAD_STATE ?? "/var/lib/launch-pad/state.json";
const PORT_MIN = HOST_PORT_MIN;
const PORT_RANGE = HOST_PORT_COUNT;

export interface LocalState {
  /** Stable host-port allocations keyed by `project/service`. */
  ports: Record<string, number>;
}

export function loadState(): LocalState {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<LocalState>;
    return { ports: raw.ports ?? {} };
  } catch {
    return { ports: {} };
  }
}

export function saveState(state: LocalState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    // Write to a temp file then atomically rename over the real one. A bare
    // writeFileSync truncates-then-writes, so a crash mid-write would leave a
    // truncated/empty state.json — loadState would swallow the parse error and
    // return {}, silently dropping every port allocation and risking a port
    // collision (failed `docker run -p`) against still-running containers next
    // boot. rename() is atomic on the same filesystem, so a reader only ever sees
    // the old file or the complete new one.
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, STATE_PATH);
  } catch {
    /* a missing state dir just means ports may be reassigned next boot */
  }
}

/**
 * Non-cryptographic djb2-style hash used only to spread a (service, replica) key
 * across the host-port range — NOT a fingerprint. (Content fingerprints elsewhere
 * use sha256; don't swap this for one — it just needs cheap, stable spreading.)
 */
function placementHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministically allocate a stable host port for a (service, replica index). */
export function allocatePort(state: LocalState, key: string, index: number): number {
  const mapKey = `${key}#${index}`;
  const existing = state.ports[mapKey];
  if (existing) return existing;

  const used = new Set(Object.values(state.ports));
  let port = PORT_MIN + (placementHash(mapKey) % PORT_RANGE);
  while (used.has(port)) {
    port = PORT_MIN + ((port + 1 - PORT_MIN) % PORT_RANGE);
  }
  state.ports[mapKey] = port;
  return port;
}

/** Free a replica's port allocation (called on scale-down / rollout cleanup). */
export function releasePort(state: LocalState, key: string, index: number): void {
  delete state.ports[`${key}#${index}`];
}
