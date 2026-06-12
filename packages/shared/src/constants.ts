/**
 * Bumped whenever the on-the-wire shape of desired.json / status.json changes.
 *
 * ⚠️ Bumping this is a HARD, NON-backward-compatible cutover, NOT an additive
 * change. `DesiredStateSchema.version` is a `z.literal(PROTOCOL_VERSION)`, so the
 * instant this becomes 2, every live node still serving a `version: 1`
 * desired.json fails to parse and stops reconciling. This is the opposite of the
 * additive `.default()` rule used for ordinary field additions — prefer adding an
 * optional/defaulted field WITHOUT a version bump. Only bump as part of a
 * coordinated agent upgrade across all nodes.
 *
 * v2: dropped the `both` node role and co-located Caddy — `ingress.edge` is now a
 * required node id (was nullable, null = co-located). Every cluster is 1 dedicated
 * edge + ≥1 app node.
 */
export const PROTOCOL_VERSION = 2 as const;

/**
 * Instance type for an auto-provisioned dedicated edge node. The edge only runs
 * Caddy (no app containers), so the smallest burstable type is plenty.
 */
export const DEFAULT_EDGE_INSTANCE_TYPE = "t3.micro";

/**
 * Format version of the per-project `config-baseline.json` (see config-lock.ts).
 * This is the config-lock file format, NOT the wire protocol — it happens to also
 * be 1 right now, but it is a SEPARATE number from PROTOCOL_VERSION and the two
 * are bumped independently.
 */
export const CONFIG_BASELINE_VERSION = 1 as const;

/**
 * Format version of an append-only `events/<id>.json` deploy-history record (see
 * events.ts). Separate from PROTOCOL_VERSION / CONFIG_BASELINE_VERSION; bumped on its
 * own. History is advisory (audit + rollback hint), never load-bearing for reconcile.
 */
export const DEPLOY_EVENT_VERSION = 1 as const;

/**
 * Format version of a footprint's `preview.json` marker (see preview.ts). Written by
 * `deploy --env`, read only by the `preview` CLI commands (list / destroy / prune) —
 * the agent never sees it, so this is NOT part of PROTOCOL_VERSION.
 */
export const PREVIEW_MARKER_VERSION = 1 as const;

/**
 * Format version of a logical project's component index, `projects/_index/<project>.json`
 * (see project-registry.ts). Written on deploy, read by `project list/show` and
 * `destroy --project`. CLI-only state — the agent never reads it, so this is NOT
 * part of PROTOCOL_VERSION.
 */
export const PROJECT_INDEX_VERSION = 1 as const;

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
  configStamp: "launchpad.configStamp",
  /**
   * Scheduled-job run marker: the cron FIRE TIME (epoch ms) this container was
   * started for. Presence distinguishes a cron run container from a long-running
   * replica; the value is the durable "last fire" record the due-run check reads.
   */
  cronFire: "launchpad.cronFire",
} as const;

/**
 * Capacity held back on every node for the OS, the agent process and Caddy, so
 * we never pack a node to 100% and starve the host. Subtracted from the node's
 * instance-type total to get allocatable capacity.
 */
export const DEFAULT_RESERVED_CPU = 256; // vCPU shares (0.25 vCPU)
export const DEFAULT_RESERVED_MEMORY = 512; // MB

/**
 * Timing cadences below have a required ordering — keep it intact or a healthy
 * node can flicker "stale" to the CLI:
 *
 *     DEFAULT_POLL_INTERVAL_MS  ≤  LIVENESS_HEARTBEAT_MS  ≤  HEARTBEAT_STALE_MS / 2
 *
 * Liveness is only re-published once per poll tick, so the poll interval must be
 * at least as frequent as the liveness beat, which in turn must beat at least
 * twice per stale window. (The stats sampling cadence lives separately in
 * stats.ts as STATS_DEFAULT_INTERVAL_MS and is not part of this constraint.)
 */

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
 *
 * 20000 sits above the common application/registered ports and below the Linux
 * ephemeral range (32768+), so published ports don't collide with the OS's
 * outbound source ports. The 10000-wide window is the effective cap on web
 * replicas per node.
 */
export const HOST_PORT_MIN = 20000;
export const HOST_PORT_COUNT = 10000;
export const HOST_PORT_MAX = HOST_PORT_MIN + HOST_PORT_COUNT - 1;

/** Default agent poll interval, also used by the CLI watcher cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
