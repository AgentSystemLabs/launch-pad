/** Bumped whenever the on-the-wire shape of desired.json / status.json changes. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The implicit cluster every pre-cluster node belongs to. Its state lives at the
 * legacy un-prefixed `nodes/<id>/` root (no `clusters/` segment) so existing nodes
 * keep working with no migration. Named clusters scope under `clusters/<id>/`.
 */
export const DEFAULT_CLUSTER = "default";

/**
 * Injected into each container's environment when `deploy --env <name>` is used.
 * Omitted on a production deploy (no `--env`). A user value in `[[service]].env`
 * for this key wins over the CLI-injected value.
 */
export const LAUNCH_PAD_ENVIRONMENT = "LAUNCH_PAD_ENVIRONMENT" as const;

/** Docker label keys the agent uses to find and identify managed containers. */
export const LABELS = {
  managed: "launchpad.managed",
  project: "launchpad.project",
  service: "launchpad.service",
  image: "launchpad.image",
  replica: "launchpad.replica",
  cpu: "launchpad.cpu",
  memory: "launchpad.memory",
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

/**
 * How often an agent re-publishes status.json purely as a liveness heartbeat when
 * nothing else changed. The agent writes status-on-change; between changes it still
 * beats at this cadence so the CLI's `isHeartbeatStale` stays reliable. MUST stay
 * well under HEARTBEAT_STALE_MS — keep it ≤ half so a node never flickers stale
 * between beats. Override per-agent with LAUNCHPAD_LIVENESS_MS.
 */
export const LIVENESS_HEARTBEAT_MS = 30_000;

/**
 * Host-port range the agent publishes web replicas on. The same range is opened
 * (edge SG → app node) so a dedicated edge can reach app containers over the VPC.
 */
export const HOST_PORT_MIN = 20000;
export const HOST_PORT_COUNT = 10000;
export const HOST_PORT_MAX = HOST_PORT_MIN + HOST_PORT_COUNT - 1;

/** Default agent poll interval, also used by the CLI watcher cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
