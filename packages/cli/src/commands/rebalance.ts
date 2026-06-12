import { Command } from "commander";
import {
  DEFAULT_CLUSTER,
  footprintOwner,
  LABEL_REGEX,
  type NodeRegistryEntry,
  nodeFrontsIngress,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  type ServiceConfig,
  type ServiceDecl,
  resolveServiceDomain,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { awsErrorName } from "../aws/errors";
import { getJson } from "../aws/s3-state";
import { getClusterConfig } from "../cluster/store";
import { findConfigPath, loadConfig } from "../config/load";
import { rememberClusterTarget } from "../config/local";
import { buildCandidateNodes } from "../deploy/candidate-nodes";
import {
  buildPlacementSnapshot,
  type DeployedPlacementSnapshot,
  type NodeDesiredState,
  loadNodeDesiredStates,
} from "../deploy/deployed-footprint";
import {
  type ClusterServiceInput,
  type Placement,
  planClusterPlacement,
} from "../deploy/placement";
import {
  type RebalanceDiff,
  type ServicePlacement,
  currentPlacement,
  diffPlacement,
} from "../deploy/rebalance-plan";
import { type WatchTarget, waitForConvergence } from "../deploy/watch";
import { enforceConfigLock, publishDesired, publishEdgeConfig, toServiceConfig } from "./deploy";
import { CliError, EvacuationBlockedError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

export interface RebalanceOptions extends GlobalOpts {
  env?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** Exclude this node from the schedulable pool — evacuate the footprint off it. */
  drain?: string;
  /**
   * Exclude several nodes at once (used by `node destroy --evacuate` when tearing down
   * more than one node so a replica never migrates onto a sibling that's also going away).
   * Unioned with `drain`.
   */
  drainNodes?: string[];
  /**
   * Block until the republished placement converges (every gainer/stayer reports its new
   * running replica count). Used by `node destroy --evacuate` so we never terminate the
   * drained node before its replicas are confirmed up elsewhere.
   */
  wait?: boolean;
  /** Seconds to wait for convergence when `wait` is set (default 300). */
  timeout?: number;
  /** Suppress the terminal success/JSON output so a calling command owns the conclusion. */
  quiet?: boolean;
}

/** Default seconds `rebalance --wait` (and `node destroy --evacuate`) waits for convergence. */
const DEFAULT_REBALANCE_TIMEOUT_SECONDS = 300;

/** The set of nodes to exclude from the schedulable pool — union of `drain` + `drainNodes`. */
export function resolveDrainSet(
  drain: string | undefined,
  drainNodes: string[] | undefined,
): Set<string> {
  const set = new Set<string>();
  if (drain !== undefined) set.add(drain);
  for (const id of drainNodes ?? []) set.add(id);
  return set;
}

/** A service's resolved placement after re-planning (reusing its published image). */
interface Resolved {
  placements: Placement[];
  edge: string | null;
  domain: string | undefined;
}

const isWeb = (s: ServiceDecl): boolean => s.domain !== undefined && s.port !== undefined;

/** Build per-service node→replicas maps from the freshly-resolved placement. */
function plannedPlacement(resolved: Map<string, Resolved>): ServicePlacement[] {
  return [...resolved].map(([service, r]) => ({
    service,
    byNode: new Map(r.placements.map((p) => [p.nodeId, p.replicas])),
  }));
}

export async function runRebalance(opts: RebalanceOptions): Promise<void> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run rebalance from your project directory (or a parent)",
    });
  }
  const { config } = loadConfig();

  const env = opts.env;
  if (env !== undefined && !LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const ownerProject = footprintOwner(config, env);

  const aws = await prepareAws(opts);
  log.step(`cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`);
  if (env !== undefined) log.step(`environment ${color.cyan(env)} · footprint ${color.cyan(ownerProject)}`);
  if (!opts.dryRun) rememberClusterTarget(aws.clusterId, { region: aws.region, profile: opts.profile });

  // Rebalance must not sneak a config change in — the toml has to match the locked baseline.
  await enforceConfigLock(aws, config, ownerProject);

  const clusterCfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);

  const pool = await buildCandidateNodes(aws, ownerProject, { needsCapacitySnapshot: true });
  const nodes = pool.nodes;
  let candidateNodes = pool.candidateNodes;
  let clusterAppNodeIds = pool.clusterAppNodeIds;

  // The cluster's dedicated edge fronting every web service: cluster.json's
  // defaultEdge, else the registry's single edge-role node. Rebalance never
  // provisions, so a missing edge is a hard error (deploy creates it).
  let clusterEdgeId: string | null = clusterCfg?.defaultEdge ?? null;
  if (clusterEdgeId === null) {
    const edgeRoleNodes = [...nodes.values()].filter((n) => nodeFrontsIngress(n.role)).map((n) => n.nodeId);
    if (edgeRoleNodes.length > 1) {
      throw new CliError(
        `cluster "${aws.clusterId}" has ${edgeRoleNodes.length} edge nodes (${edgeRoleNodes.join(", ")}) and no default`,
        { hint: `pick one: launchpad cluster set-edge ${aws.clusterId} <node-id>` },
      );
    }
    clusterEdgeId = edgeRoleNodes[0] ?? null;
  }

  // `--drain` / `drainNodes`: evacuate the footprint off node(s) by removing them from
  // the schedulable pool. A volume-bearing service can't move (its data is node-local),
  // so one on a drained node is a hard block — `EvacuationBlockedError` so a calling
  // command (`node destroy --evacuate`) can tell it apart from a real failure.
  const drainSet = resolveDrainSet(opts.drain, opts.drainNodes);
  if (drainSet.size > 0) {
    const drainList = [...drainSet].sort();
    for (const id of drainList) {
      if (!nodes.has(id)) {
        throw new CliError(`node "${id}" is not in cluster "${aws.clusterId}"`, {
          hint: "pass an app node id from `launchpad node list`",
        });
      }
    }
    candidateNodes = candidateNodes.filter((c) => !drainSet.has(c.nodeId));
    clusterAppNodeIds = clusterAppNodeIds.filter((id) => !drainSet.has(id));
  }

  if (clusterAppNodeIds.length === 0) {
    if (drainSet.size > 0) {
      throw new EvacuationBlockedError(
        `draining ${quoteList([...drainSet].sort())} would leave cluster "${aws.clusterId}" with no app nodes`,
        { hint: `add capacity first: launchpad node create <name> --cluster ${aws.clusterId} --role app` },
      );
    }
    throw new CliError(`cluster "${aws.clusterId}" has no app nodes to place services on`, {
      hint: `create one: launchpad node create <name> --cluster ${aws.clusterId} --role app`,
    });
  }

  // Current placement + each service's published image (rebalance reuses, never rebuilds).
  let states: NodeDesiredState[];
  try {
    states = await loadNodeDesiredStates(aws.s3, aws.bucket, aws.clusterId);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") states = [];
    else throw error;
  }
  const priorPlacement = buildPlacementSnapshot(states, ownerProject);
  if (priorPlacement.footprints.length === 0) {
    throw new CliError(`nothing is deployed for "${ownerProject}" — run \`launchpad deploy\` first`, {
      hint: "rebalance redistributes an already-deployed footprint; it doesn't create one",
    });
  }
  const imageByService = new Map<string, string>();
  for (const { services } of states) {
    for (const s of services) {
      if (s.project === ownerProject) imageByService.set(s.service, s.image);
    }
  }

  /** The node a service currently occupies (sticky volume placement). */
  const publishedNodeOf = (serviceName: string): string | null => {
    for (const [nodeId, occupancies] of priorPlacement.byNode) {
      if (occupancies.some((o) => o.service === serviceName)) return nodeId;
    }
    return null;
  };

  // A volume service is sticky to its current node — draining that node would strand
  // the data, so it's a hard block (the planner would otherwise re-place it fresh).
  if (drainSet.size > 0) {
    const stuck = config.service.filter((s) => {
      if (s.volumes.length === 0) return false;
      const current = publishedNodeOf(s.name);
      return current !== null && drainSet.has(current);
    });
    if (stuck.length > 0) {
      throw new EvacuationBlockedError(
        `can't evacuate ${quoteList([...drainSet].sort())}: ${stuck.map((s) => s.name).join(", ")} ` +
          `keep persistent volumes there`,
        { hint: "a volume service can't move nodes without stranding its data — destroy it first or keep the node" },
      );
    }
  }

  // Resolve the new placement (volume services stay put via their sticky node).
  const resolved = new Map<string, Resolved>();
  const clusterInputs: ClusterServiceInput[] = [];
  for (const s of config.service) {
    clusterInputs.push({
      name: s.name,
      replicas: s.replicas,
      cpu: s.cpu,
      memory: s.memory,
      maxSurge: s.rollout.maxSurge,
      isWeb: isWeb(s),
      hasVolumes: s.volumes.length > 0,
      stickyNodeId: s.volumes.length > 0 ? publishedNodeOf(s.name) : null,
    });
  }
  for (const plan of planClusterPlacement({
    clusterId: aws.clusterId,
    nodes: candidateNodes,
    services: clusterInputs,
  })) {
    const decl = config.service.find((s) => s.name === plan.service) as ServiceDecl;
    if (isWeb(decl) && clusterEdgeId === null) {
      throw new CliError(`service "${decl.name}" serves a domain but cluster "${aws.clusterId}" has no edge node`, {
        hint: "run `launchpad deploy` to provision the cluster's dedicated edge first",
      });
    }
    resolved.set(plan.service, {
      placements: plan.placements,
      edge: isWeb(decl) ? clusterEdgeId : null,
      domain: resolveServiceDomain(
        { domain: decl.domain, domainPattern: decl.domainPattern ?? config.domainPattern, service: decl.name },
        env,
      ),
    });
  }

  const draining = drainSet.size > 0;
  const drainLabel = [...drainSet].sort().join(", ");
  const diff = diffPlacement(currentPlacement(priorPlacement), plannedPlacement(resolved));

  if (!diff.changed) {
    if (isJsonMode()) {
      if (!opts.quiet) printJson({ rebalanced: false, reason: "already-balanced", project: ownerProject });
      return;
    }
    if (!opts.quiet) {
      log.success(
        draining
          ? `${color.cyan(ownerProject)} has nothing on ${color.cyan(drainLabel)} — nothing to evacuate`
          : `${color.cyan(ownerProject)} is already balanced across ${clusterAppNodeIds.length} node(s) — nothing to move`,
      );
    }
    return;
  }

  reportPlan(diff, opts.dryRun === true);

  if (opts.dryRun) {
    if (isJsonMode()) printJson({ rebalanced: false, dryRun: true, project: ownerProject, ...diffJson(diff) });
    return;
  }

  // Every moved service must have a published image to reuse (rebalance never builds).
  const missing = [...resolved.keys()].filter((name) => !imageByService.has(name));
  if (missing.length > 0) {
    throw new CliError(`no published image for: ${missing.join(", ")}`, {
      hint: "rebalance reuses published images — deploy these services first",
    });
  }

  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`move ${diff.changes.length} placement(s)?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  await applyRebalance(aws, ownerProject, env, resolved, diff, nodes, imageByService);

  // `wait`: block until the surviving pool reports its new running replica counts — so a
  // caller (`node destroy --evacuate`) never tears down the drained node before its replicas
  // are confirmed up elsewhere. Throws on non-convergence so the destroy aborts (fail-safe).
  if (opts.wait === true) {
    const cronServices = new Set(config.service.filter((s) => s.cron !== undefined).map((s) => s.name));
    await waitForRebalanceConvergence(aws, ownerProject, resolved, imageByService, cronServices, opts);
  }

  if (isJsonMode()) {
    if (!opts.quiet) {
      printJson({ rebalanced: true, project: ownerProject, drained: draining ? [...drainSet].sort() : null, ...diffJson(diff) });
    }
    return;
  }
  if (opts.quiet) return;
  if (draining) {
    log.success(`evacuated ${color.cyan(ownerProject)} off ${color.cyan(drainLabel)} — the agents converge on their next poll`);
    log.dim(`  once \`launchpad status\` shows it drained, you can pause/destroy ${drainLabel}`);
  } else {
    log.success(`rebalanced ${color.cyan(ownerProject)} — the agents converge on their next poll`);
    log.dim("  run `launchpad status` to watch the replicas move");
  }
}

/** Quote + comma-join a list of ids for an error message: `"a", "b"`. */
function quoteList(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

/**
 * Wait for a republished placement to converge: every (node, service) in `resolved`
 * reports its target running replica count on the reused image. Drained nodes aren't in
 * `resolved`, so we don't wait on them (the caller is about to terminate them anyway).
 */
async function waitForRebalanceConvergence(
  aws: AwsEnv,
  ownerProject: string,
  resolved: Map<string, Resolved>,
  imageByService: Map<string, string>,
  cronServices: ReadonlySet<string>,
  opts: RebalanceOptions,
): Promise<void> {
  const targets: WatchTarget[] = [];
  for (const [service, r] of resolved) {
    const image = imageByService.get(service);
    if (image === undefined) continue;
    for (const p of r.placements) {
      if (p.replicas <= 0) continue;
      targets.push({
        nodeId: p.nodeId,
        project: ownerProject,
        service,
        image,
        // A cron service idles at 0 running replicas — converged = reported without error.
        expectedReplicas: cronServices.has(service) ? 0 : p.replicas,
      });
    }
  }
  if (targets.length === 0) return;

  const timeoutMs = (opts.timeout ?? DEFAULT_REBALANCE_TIMEOUT_SECONDS) * 1000;
  const spin = isJsonMode() ? null : spinner("waiting for the footprint to converge elsewhere…").start();
  const results = await waitForConvergence(aws.s3, aws.bucket, aws.clusterId, targets, timeoutMs, (rs) => {
    if (!spin) return;
    const ready = rs.filter((r) => r.ok).length;
    spin.text = `converging: ${ready}/${rs.length} placements ready`;
  });
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    spin?.fail("the footprint did not converge in time");
    throw new CliError(
      `evacuation published but ${failed.length} placement(s) haven't converged yet`,
      {
        hint: "the desired state is written; watch `launchpad status` and re-run the destroy once it's running — nothing was torn down",
      },
    );
  }
  spin?.succeed("the footprint is running on the surviving nodes");
}

/** Publish the new placement (additions first), then clean nodes the footprint fully left. */
async function applyRebalance(
  aws: AwsEnv,
  ownerProject: string,
  env: string | undefined,
  resolved: Map<string, Resolved>,
  diff: RebalanceDiff,
  nodes: Map<string, NodeRegistryEntry>,
  imageByService: Map<string, string>,
): Promise<void> {
  const { config } = loadConfig();
  const declByName = new Map(config.service.map((s) => [s.name, s]));

  // Group the resolved placement by node into ServiceConfigs.
  const nodePlacements = new Map<string, ServiceConfig[]>();
  for (const [name, r] of resolved) {
    const decl = declByName.get(name) as ServiceDecl;
    const image = imageByService.get(name) as string;
    for (const p of r.placements) {
      const list = nodePlacements.get(p.nodeId) ?? [];
      list.push(toServiceConfig(aws, ownerProject, { decl, image, domain: r.domain }, p.replicas, r.edge, env, false));
      nodePlacements.set(p.nodeId, list);
    }
  }

  const entryFor = async (id: string): Promise<NodeRegistryEntry | null> => {
    const known = nodes.get(id);
    if (known) return known;
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    return obj ? parseNodeRegistryEntry(obj.raw) : null;
  };

  // Per-node net replica delta (planned − current) from the diff, so we can publish
  // GAINERS before REDUCERS: a moved replica exists somewhere at all times (no
  // under-replication window — load-bearing for zero-downtime on web services).
  const nodeDelta = new Map<string, number>();
  for (const c of diff.changes) nodeDelta.set(c.node, (nodeDelta.get(c.node) ?? 0) + (c.to - c.from));
  const ordered = [...nodePlacements.entries()].sort(
    ([a], [b]) => (nodeDelta.get(b) ?? 0) - (nodeDelta.get(a) ?? 0),
  );

  // Resolve every TARGET node's registry entry BEFORE writing anything — a node that
  // vanished between the snapshot and now must abort the whole rebalance with zero writes,
  // never half-apply (a gainer node going missing mid-sequence would leave the footprint
  // split). Vacated nodes are best-effort (handled below), so they're resolved separately.
  const entries = new Map<string, NodeRegistryEntry>();
  for (const [id] of ordered) {
    const entry = await entryFor(id);
    if (!entry) {
      throw new CliError(`node "${id}" is no longer in cluster "${aws.clusterId}" — can't place services on it`, {
        hint: "the cluster changed under the plan — re-run `launchpad rebalance`",
      });
    }
    entries.set(id, entry);
  }

  const spin = isJsonMode() ? null : spinner("publishing new placement…").start();
  try {
    // Gainers first, then reducers; vacated nodes (full removal) last.
    for (const [id, services] of ordered) {
      await publishDesired(aws, id, entries.get(id) as NodeRegistryEntry, ownerProject, services);
    }
    for (const id of diff.vacatedNodes) {
      const entry = await entryFor(id);
      if (!entry) {
        log.warn(`node "${id}" previously hosted ${ownerProject} but is gone — skipping cleanup`);
        continue;
      }
      await publishDesired(aws, id, entry, ownerProject, []);
    }
    spin?.succeed(`published placement to ${nodePlacements.size} node(s)`);
  } catch (error) {
    spin?.fail("rebalance failed");
    throw error;
  }

  // Re-publish each referenced edge's domain list (a moved web service may add a domain).
  const edgeIds = new Set<string>();
  for (const r of resolved.values()) if (r.edge) edgeIds.add(r.edge);
  for (const edgeId of edgeIds) {
    const domains: string[] = [];
    for (const r of resolved.values()) if (r.edge === edgeId && r.domain) domains.push(r.domain);
    await publishEdgeConfig(aws, edgeId, domains);
  }
}

function diffJson(diff: RebalanceDiff): Record<string, unknown> {
  return {
    moves: diff.changes.map((c) => ({ service: c.service, node: c.node, from: c.from, to: c.to })),
    vacatedNodes: diff.vacatedNodes,
  };
}

function reportPlan(diff: RebalanceDiff, dryRun: boolean): void {
  if (isJsonMode()) return;
  const lines = diff.changes.map((c) => {
    const arrow = c.to > c.from ? color.green(`${c.from} → ${c.to}`) : color.yellow(`${c.from} → ${c.to}`);
    return `${color.cyan(c.service)} on ${color.cyan(c.node)}  ${arrow}`;
  });
  if (diff.vacatedNodes.length > 0) {
    lines.push(color.dim(`vacates: ${diff.vacatedNodes.join(", ")}`));
  }
  panel(dryRun ? "Rebalance (dry run)" : "Rebalance", lines);
}

export function registerRebalance(program: Command): void {
  const cmd = program
    .command("rebalance")
    .description("Replan the footprint's services across the current app pool (after adding/removing nodes)")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--drain <node>", "evacuate the footprint OFF this node (exclude it from the pool)")
    .option("--dry-run", "show the moves without writing any state")
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "Rebalance re-runs the cluster scheduler over the CURRENT app pool and republishes the",
        "footprint's services to match — reusing each service's already-published image (no",
        "rebuild). Use it after adding an app node (to spread load onto it) or before removing",
        "one. A service with [[service.volumes]] never moves (its data is node-local).",
        "",
        "It is config-lock-safe: the launch-pad.toml must match the deployed baseline (only the",
        "placement over the live pool changes).",
        "",
        "Convergence is eventual: rebalance republishes desired state and each node's agent",
        "reconciles on its next poll (it publishes nodes that gain replicas before nodes that",
        "shed them, but doesn't health-gate across nodes). Don't run it concurrently with a",
        "deploy/scale of the same footprint — a re-run reconciles any interleaving safely.",
        "",
        "Examples:",
        "  $ launchpad rebalance --dry-run     # preview the moves",
        "  $ launchpad rebalance --yes         # apply them",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runRebalance(mergedOpts<RebalanceOptions>(command));
    });

  applyGlobalOptions(cmd);
}
