import { Command } from "commander";
import {
  DEFAULT_CLUSTER,
  envProject,
  LABEL_REGEX,
  type NodeRegistryEntry,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  type ServiceConfig,
  type ServiceDecl,
  resolveServiceDomain,
  targetNodes,
  usesClusterPlacement,
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
  distributeReplicas,
  planClusterPlacement,
} from "../deploy/placement";
import { type RebalanceDiff, type ServicePlacement, diffPlacement } from "../deploy/rebalance-plan";
import { enforceConfigLock, publishDesired, publishEdgeConfig, toServiceConfig } from "./deploy";
import { CliError } from "../errors";
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
}

/** A service's resolved placement after re-planning (reusing its published image). */
interface Resolved {
  placements: Placement[];
  edge: string | null;
  domain: string | undefined;
}

const isWeb = (s: ServiceDecl): boolean => s.domain !== undefined && s.port !== undefined;

/** Build per-service node→replicas maps from a footprint's published placement. */
function currentPlacement(snapshot: DeployedPlacementSnapshot): ServicePlacement[] {
  const byService = new Map<string, Map<string, number>>();
  for (const [nodeId, occupancies] of snapshot.byNode) {
    for (const occ of occupancies) {
      const m = byService.get(occ.service) ?? new Map<string, number>();
      m.set(nodeId, occ.replicas);
      byService.set(occ.service, m);
    }
  }
  return [...byService].map(([service, byNode]) => ({ service, byNode }));
}

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
  const ownerProject = envProject(config.project, env);

  // Only cluster-placed services (omit node/nodes) can be moved; pinned placement is
  // frozen by the config lock, so there's nothing to rebalance if none are cluster-placed.
  const clusterServices = config.service.filter((s) => usesClusterPlacement(s));
  if (clusterServices.length === 0) {
    throw new CliError(`no cluster-placed services in "${config.project}" to rebalance`, {
      hint: "rebalance moves services that omit node/nodes (schedule/topology); pinned services are fixed",
    });
  }

  const aws = await prepareAws(opts);
  log.step(`cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`);
  if (env !== undefined) log.step(`environment ${color.cyan(env)} · footprint ${color.cyan(ownerProject)}`);
  if (!opts.dryRun) rememberClusterTarget(aws.clusterId, { region: aws.region, profile: opts.profile });

  // Rebalance must not sneak a config change in — the toml has to match the locked baseline.
  await enforceConfigLock(aws, config, ownerProject, {});

  const clusterCfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);
  const clusterDefaultEdge = clusterCfg?.defaultEdge ?? null;

  const needsCapacitySnapshot = clusterServices.some((s) => s.schedule === "capacity");
  const pool = await buildCandidateNodes(aws, ownerProject, { needsCapacitySnapshot });
  const nodes = pool.nodes;
  let candidateNodes = pool.candidateNodes;
  let clusterAppNodeIds = pool.clusterAppNodeIds;

  // `--drain`: evacuate the footprint off a node by removing it from the schedulable pool.
  // Pinned (node/nodes) services on it can't move — their placement is config-locked.
  if (opts.drain !== undefined) {
    if (!nodes.has(opts.drain)) {
      throw new CliError(`node "${opts.drain}" is not in cluster "${aws.clusterId}"`, {
        hint: "pass an app/both node id from `launch-pad node list`",
      });
    }
    const pinnedOnNode = config.service.filter(
      (s) => !usesClusterPlacement(s) && targetNodes(s).includes(opts.drain as string),
    );
    if (pinnedOnNode.length > 0) {
      throw new CliError(
        `can't evacuate "${opts.drain}": ${pinnedOnNode.map((s) => s.name).join(", ")} pinned to it`,
        { hint: "pinned placement is config-locked — undeploy those services or recreate the footprint to move them" },
      );
    }
    candidateNodes = candidateNodes.filter((c) => c.nodeId !== opts.drain);
    clusterAppNodeIds = clusterAppNodeIds.filter((id) => id !== opts.drain);
  }

  if (clusterAppNodeIds.length === 0) {
    throw new CliError(
      opts.drain !== undefined
        ? `draining "${opts.drain}" would leave cluster "${aws.clusterId}" with no app nodes`
        : `cluster "${aws.clusterId}" has no app nodes to place services on`,
      { hint: `create one: launch-pad node create <name> --cluster ${aws.clusterId} --role app` },
    );
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
    throw new CliError(`nothing is deployed for "${ownerProject}" — run \`launch-pad deploy\` first`, {
      hint: "rebalance redistributes an already-deployed footprint; it doesn't create one",
    });
  }
  const imageByService = new Map<string, string>();
  for (const { services } of states) {
    for (const s of services) {
      if (s.project === ownerProject) imageByService.set(s.service, s.image);
    }
  }

  // Resolve the new placement: pinned services stay; cluster-placed services re-plan.
  const resolved = new Map<string, Resolved>();
  const clusterInputs: ClusterServiceInput[] = [];
  for (const s of config.service) {
    const domain = resolveServiceDomain(
      { domain: s.domain, domainPattern: s.domainPattern ?? config.domainPattern, service: s.name },
      env,
    );
    if (!usesClusterPlacement(s)) {
      const nodeIds = targetNodes(s);
      resolved.set(s.name, {
        placements: distributeReplicas(nodeIds, s.replicas),
        edge: isWeb(s) ? (s.edge ?? clusterDefaultEdge) : null,
        domain,
      });
      // Seed the capacity scheduler with this pinned demand so a replan respects it.
      for (const p of distributeReplicas(nodeIds, s.replicas)) {
        const cn = candidateNodes.find((c) => c.nodeId === p.nodeId);
        if (!cn) continue;
        cn.steadyCpu += s.cpu * p.replicas;
        cn.steadyMemory += s.memory * p.replicas;
        cn.maxSurgeCpu = Math.max(cn.maxSurgeCpu, s.cpu * Math.min(s.rollout.maxSurge, p.replicas));
        cn.maxSurgeMemory = Math.max(cn.maxSurgeMemory, s.memory * Math.min(s.rollout.maxSurge, p.replicas));
      }
      continue;
    }
    clusterInputs.push({
      name: s.name,
      replicas: s.replicas,
      cpu: s.cpu,
      memory: s.memory,
      maxSurge: s.rollout.maxSurge,
      isWeb: isWeb(s),
      explicitEdge: s.edge ?? null,
      schedule: s.schedule,
      topology: s.topology,
    });
  }
  for (const plan of planClusterPlacement({
    clusterId: aws.clusterId,
    clusterDefaultEdge,
    nodes: candidateNodes,
    services: clusterInputs,
  })) {
    const decl = config.service.find((s) => s.name === plan.service) as ServiceDecl;
    resolved.set(plan.service, {
      placements: plan.placements,
      edge: plan.edge,
      domain: resolveServiceDomain(
        { domain: decl.domain, domainPattern: decl.domainPattern ?? config.domainPattern, service: decl.name },
        env,
      ),
    });
  }

  const diff = diffPlacement(currentPlacement(priorPlacement), plannedPlacement(resolved));

  if (!diff.changed) {
    if (isJsonMode()) {
      printJson({ rebalanced: false, reason: "already-balanced", project: ownerProject });
      return;
    }
    log.success(
      opts.drain !== undefined
        ? `${color.cyan(ownerProject)} has nothing on ${color.cyan(opts.drain)} — nothing to evacuate`
        : `${color.cyan(ownerProject)} is already balanced across ${clusterAppNodeIds.length} node(s) — nothing to move`,
    );
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

  if (isJsonMode()) {
    printJson({ rebalanced: true, project: ownerProject, drained: opts.drain ?? null, ...diffJson(diff) });
    return;
  }
  if (opts.drain !== undefined) {
    log.success(`evacuated ${color.cyan(ownerProject)} off ${color.cyan(opts.drain)} — the agents converge on their next poll`);
    log.dim(`  once \`launch-pad status\` shows it drained, you can pause/destroy ${opts.drain}`);
  } else {
    log.success(`rebalanced ${color.cyan(ownerProject)} — the agents converge on their next poll`);
    log.dim("  run `launch-pad status` to watch the replicas move");
  }
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
        hint: "the cluster changed under the plan — re-run `launch-pad rebalance`",
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
    .description("Replan cluster-placed services across the current app pool (after adding/removing nodes)")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--drain <node>", "evacuate the footprint OFF this node (exclude it from the pool)")
    .option("--dry-run", "show the moves without writing any state")
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "Rebalance re-runs the cluster scheduler over the CURRENT app pool and republishes the",
        "footprint's cluster-placed services (those that omit node/nodes) to match — reusing each",
        "service's already-published image (no rebuild). Use it after adding an app node (to spread",
        "load onto it) or before removing one. Pinned (node/nodes) services never move.",
        "",
        "It is config-lock-safe: the launch-pad.toml must match the deployed baseline (only the",
        "placement, derived from schedule/topology over the live pool, changes).",
        "",
        "Convergence is eventual: rebalance republishes desired state and each node's agent",
        "reconciles on its next poll (it publishes nodes that gain replicas before nodes that",
        "shed them, but doesn't health-gate across nodes). Don't run it concurrently with a",
        "deploy/scale of the same footprint — a re-run reconciles any interleaving safely.",
        "",
        "Examples:",
        "  $ launch-pad rebalance --dry-run     # preview the moves",
        "  $ launch-pad rebalance --yes         # apply them",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runRebalance(mergedOpts<RebalanceOptions>(command));
    });

  applyGlobalOptions(cmd);
}
