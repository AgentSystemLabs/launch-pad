/**
 * Pure decision logic for `node resize --evacuate` (non-disruptive vertical scale):
 * evacuate the current project's cluster-placed services off the node, resize the
 * empty(er) instance, then rebalance back. Pure so the drain-vs-refuse decision is
 * unit-tested without S3/AWS — the command in ./index.ts composes the side effects
 * (`rebalance --drain --wait` → `resizeNode` → `rebalance --wait`).
 */

/** A (project, service) pair scheduled on the node being resized. */
export interface ResizeScheduledService {
  project: string;
  service: string;
}

export type ResizeEvacuationPlan =
  /**
   * The node is paused: nothing is running (so there is no downtime to avoid), and the
   * post-resize rebalance-back would wait forever on a stopped agent. Plain resize instead.
   */
  | { kind: "refuse-stopped" }
  /**
   * A drain is wanted (movable services exist) but this project also pins a service to
   * the node — `rebalance --drain` hard-blocks on that (pinned placement is config-locked),
   * so refuse up front instead of failing mid-flight.
   */
  | { kind: "refuse-pinned"; pinned: ResizeScheduledService[] }
  /** Nothing this project can move — evacuation would be a no-op; resize in place. */
  | { kind: "resize-only"; ridesDowntime: ResizeScheduledService[] }
  /**
   * Drain the node first; `ridesDowntime` is what stays behind during the stop/start
   * (other projects' services — not this footprint's to move).
   */
  | { kind: "drain"; ridesDowntime: ResizeScheduledService[] };

/**
 * Decide what `--evacuate` can do for a resize. A service is movable iff it belongs to
 * `ownerProject` AND is cluster-placed (omits node/nodes — its name is in
 * `clusterPlacedNames`); pinned services are config-locked and other projects' services
 * are not this footprint's to move.
 */
export function planResizeEvacuation(args: {
  /** The node's registry state (`"stopped"` = paused). */
  nodeState: string;
  /** Every service currently scheduled on the node (from its desired.json). */
  services: ResizeScheduledService[];
  /** The footprint being evacuated (project, or project-env). */
  ownerProject: string;
  /** Names of this project's cluster-placed services (those that omit node/nodes). */
  clusterPlacedNames: Set<string>;
}): ResizeEvacuationPlan {
  if (args.nodeState === "stopped") return { kind: "refuse-stopped" };

  const isMovable = (s: ResizeScheduledService): boolean =>
    s.project === args.ownerProject && args.clusterPlacedNames.has(s.service);
  const hasMovable = args.services.some(isMovable);
  const unmovable = args.services.filter((s) => !isMovable(s));
  if (!hasMovable) return { kind: "resize-only", ridesDowntime: unmovable };

  const pinned = unmovable.filter((s) => s.project === args.ownerProject);
  if (pinned.length > 0) return { kind: "refuse-pinned", pinned };
  return { kind: "drain", ridesDowntime: unmovable };
}
