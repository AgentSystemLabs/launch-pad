/** Bumped whenever the on-the-wire shape of desired.json / status.json changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Docker label keys the agent uses to find and identify managed containers. */
export const LABELS = {
  managed: "launchpad.managed",
  project: "launchpad.project",
  service: "launchpad.service",
  image: "launchpad.image",
} as const;

/**
 * Capacity held back on every node for the OS, the agent process and Caddy, so
 * we never pack a node to 100% and starve the host. Subtracted from the node's
 * instance-type total to get allocatable capacity.
 */
export const DEFAULT_RESERVED_CPU = 256; // vCPU shares (0.25 vCPU)
export const DEFAULT_RESERVED_MEMORY = 512; // MB

/** A node whose status heartbeat is older than this is considered offline. */
export const HEARTBEAT_STALE_MS = 60_000;

/** Default agent poll interval, also used by the CLI watcher cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
