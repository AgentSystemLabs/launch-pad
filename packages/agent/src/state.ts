import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATE_PATH = process.env.LAUNCHPAD_STATE ?? "/var/lib/launch-pad/state.json";
const PORT_MIN = 20000;
const PORT_RANGE = 10000;

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
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* a missing state dir just means ports may be reassigned next boot */
  }
}

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministically allocate a stable host port for a service key. */
export function allocatePort(state: LocalState, key: string): number {
  const existing = state.ports[key];
  if (existing) return existing;

  const used = new Set(Object.values(state.ports));
  let port = PORT_MIN + (hash(key) % PORT_RANGE);
  while (used.has(port)) {
    port = PORT_MIN + ((port + 1 - PORT_MIN) % PORT_RANGE);
  }
  state.ports[key] = port;
  return port;
}
