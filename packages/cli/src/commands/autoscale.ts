/**
 * `launchpad autoscale` — declarative, reactive node-pool autoscaling.
 *
 * The policy (min/max app nodes + CPU/memory utilization thresholds) lives in the
 * cluster's `cluster.json`; `autoscale run` is one **reconcile pass**: observe the
 * pool (registry + each node's status.json host sample), ask the pure planner
 * (`planAutoscale`, shared) for ONE action, apply it, record `lastScaleAt`, exit.
 * There is no daemon — cron the command (locally, CI, or a scheduled workflow),
 * matching the no-control-plane design.
 *
 * Scale-out provisions a new generated-name app node (sized like the largest pool node)
 * and rebalances the current project's cluster-placed services onto it. Scale-in
 * drains the chosen victim via `rebalance --drain` (waiting for the survivors to
 * converge), refuses to tear down a node that still hosts ANY service (another
 * project's, or a pinned one), then destroys it.
 */
import { Command } from "commander";
import {
  AUTOSCALE_SAMPLE_STALE_MS,
  type AutoscaleNodeObservation,
  type AutoscalePolicy,
  type ClusterConfig,
  clusterConfigKey,
  DEFAULT_CLUSTER,
  HEARTBEAT_STALE_MS,
  desiredKey,
  hostMemoryPercent,
  isHeartbeatStale,
  type NodeRegistryEntry,
  nodeFrontsIngress,
  nodeHostsContainers,
  parseAutoscalePolicy,
  parseClusterConfig,
  parseDesiredState,
  parseNodeStatus,
  planAutoscale,
  scaleOutNodeSpec,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { getDefaultVpcId } from "../aws/ec2";
import { getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { buildCandidateNodes } from "../deploy/candidate-nodes";
import { findConfigPath } from "../config/load";
import { CliError, EvacuationBlockedError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { resolveNodeAmi } from "../provision/golden-ami";
import { provisionNode, resolveCapacity } from "../provision/provision-node";
import { runRebalance } from "./rebalance";
import { teardownNode } from "./node";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";
import { readVersion } from "../version";

interface SetOptions extends GlobalOpts {
  min: string;
  max: string;
  scaleOutPercent?: string;
  scaleInPercent?: string;
  cooldown?: string;
}

interface RunOptions extends GlobalOpts {
  env?: string;
  dryRun?: boolean;
  yes?: boolean;
  timeout?: string;
}

/** Autoscale policy lives in cluster.json, which the default cluster doesn't have. */
async function requireCluster(aws: AwsEnv): Promise<{ cfg: ClusterConfig; etag: string }> {
  if (aws.clusterId === DEFAULT_CLUSTER) {
    throw new CliError("autoscale needs a named cluster (the policy lives in cluster.json)", {
      hint: "create one with `launchpad cluster create <name>` and target it via --cluster / `cluster use`",
    });
  }
  const obj = await getJson(aws.s3, aws.bucket, clusterConfigKey(aws.clusterId));
  if (!obj) {
    throw new CliError(`cluster "${aws.clusterId}" does not exist`, {
      hint: `create it first: launchpad cluster create ${aws.clusterId}`,
    });
  }
  return { cfg: parseClusterConfig(obj.raw), etag: obj.etag };
}

/**
 * CAS-write cluster.json against the etag it was read at, so a policy edit can't
 * clobber a concurrent `autoscale run` claim / `cluster set-edge` (and vice versa).
 */
async function putClusterConfigCas(aws: AwsEnv, cfg: ClusterConfig, etag: string): Promise<void> {
  try {
    await putJson(aws.s3, aws.bucket, clusterConfigKey(aws.clusterId), cfg, { ifMatch: etag });
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      throw new CliError("cluster.json changed while writing (another autoscale/cluster command ran)", {
        hint: "nothing was changed — re-run this command",
      });
    }
    throw error;
  }
}

function parseIntOpt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`invalid ${flag} "${raw}"`, { hint: "pass a non-negative whole number" });
  }
  return n;
}

// ── set / show / off ─────────────────────────────────────────────────────────────

async function runSet(opts: SetOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const { cfg, etag } = await requireCluster(aws);
  let policy: AutoscalePolicy;
  try {
    policy = parseAutoscalePolicy({
      minNodes: parseIntOpt(opts.min, "--min"),
      maxNodes: parseIntOpt(opts.max, "--max"),
      ...(opts.scaleOutPercent !== undefined
        ? { scaleOutPercent: parseIntOpt(opts.scaleOutPercent, "--scale-out-percent") }
        : {}),
      ...(opts.scaleInPercent !== undefined
        ? { scaleInPercent: parseIntOpt(opts.scaleInPercent, "--scale-in-percent") }
        : {}),
      ...(opts.cooldown !== undefined ? { cooldownSeconds: parseIntOpt(opts.cooldown, "--cooldown") } : {}),
      // Re-setting the policy intentionally resets the cooldown anchor.
      lastScaleAt: null,
    });
  } catch (error) {
    throw new CliError(`invalid autoscale policy: ${(error as Error).message.split("\n")[0]}`, {
      hint: "constraints: min ≥ 1, max ≥ min, scale-in % < scale-out %",
    });
  }
  await putClusterConfigCas(aws, { ...cfg, autoscale: policy }, etag);
  if (isJsonMode()) {
    printJson({ cluster: aws.clusterId, autoscale: policy });
    return;
  }
  log.success(`autoscale policy saved for cluster ${color.cyan(aws.clusterId)}`);
  reportPolicy(policy);
  log.dim("  apply it with `launchpad autoscale run` (cron it for hands-off scaling)");
}

async function runShow(opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const { cfg } = await requireCluster(aws);
  if (isJsonMode()) {
    printJson({ cluster: aws.clusterId, autoscale: cfg.autoscale });
    return;
  }
  if (!cfg.autoscale) {
    log.info(`cluster ${color.cyan(aws.clusterId)} has no autoscale policy`);
    log.dim("  set one: launchpad autoscale set --min 1 --max 3");
    return;
  }
  reportPolicy(cfg.autoscale);
}

async function runOff(opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const { cfg, etag } = await requireCluster(aws);
  await putClusterConfigCas(aws, { ...cfg, autoscale: null }, etag);
  if (isJsonMode()) {
    printJson({ cluster: aws.clusterId, autoscale: null });
    return;
  }
  log.success(`autoscale disabled for cluster ${color.cyan(aws.clusterId)}`);
}

function reportPolicy(p: AutoscalePolicy): void {
  panel("Autoscale policy", [
    `nodes        ${color.cyan(String(p.minNodes))} – ${color.cyan(String(p.maxNodes))}`,
    `scale out    avg cpu/memory ≥ ${color.cyan(`${p.scaleOutPercent}%`)}`,
    `scale in     every node < ${color.cyan(`${p.scaleInPercent}%`)}`,
    `cooldown     ${color.cyan(`${p.cooldownSeconds}s`)}`,
    `last action  ${p.lastScaleAt ?? color.dim("never")}`,
  ]);
}

// ── run (the reconcile pass) ─────────────────────────────────────────────────────

interface PoolEntry {
  entry: NodeRegistryEntry;
  observation: AutoscaleNodeObservation;
}

/**
 * Observe every registry node: role/state, the live host sample from status.json, and
 * the committed reservations (every project's desired demand — `ownerProject: ""`
 * matches no project, so nothing is excluded) for scale-in feasibility.
 */
async function observePool(aws: AwsEnv, defaultEdge: string | null, nowMs: number): Promise<PoolEntry[]> {
  const snapshot = await buildCandidateNodes(aws, "", { needsCapacitySnapshot: true });
  const reservedById = new Map(snapshot.candidateNodes.map((c) => [c.nodeId, c]));
  const out: PoolEntry[] = [];
  for (const [id, entry] of snapshot.nodes) {
    let cpuPercent: number | null = null;
    let memoryPercent: number | null = null;
    const statusObj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, id));
    if (statusObj) {
      try {
        const status = parseNodeStatus(statusObj.raw);
        const sample = status.host;
        const sampleMs = sample ? Date.parse(sample.sampledAt) : Number.NaN;
        const fresh =
          sample !== undefined &&
          !isHeartbeatStale(status.lastSeen, nowMs, HEARTBEAT_STALE_MS) &&
          !Number.isNaN(sampleMs) &&
          nowMs - sampleMs <= AUTOSCALE_SAMPLE_STALE_MS;
        if (fresh) {
          cpuPercent = sample.cpuPercent;
          memoryPercent = hostMemoryPercent(sample);
        }
      } catch {
        /* malformed/old status — treat as no metrics */
      }
    }

    const reserved = reservedById.get(id);
    out.push({
      entry,
      observation: {
        nodeId: entry.nodeId,
        role: entry.role,
        state: entry.state,
        // External (BYOS) nodes count toward pool size/utilization but are excluded
        // from scale-in victim candidates by the shared planner.
        provisioning: entry.provisioning,
        // The cluster's routing anchor must never be a scale-in victim.
        protected: entry.nodeId === defaultEdge,
        cpuPercent,
        memoryPercent,
        ...(reserved !== undefined
          ? {
              reserved: {
                steadyCpu: reserved.steadyCpu,
                steadyMemory: reserved.steadyMemory,
                surgeCpu: reserved.maxSurgeCpu,
                surgeMemory: reserved.maxSurgeMemory,
                allocatableCpu: reserved.allocatableCpu,
                allocatableMemory: reserved.allocatableMemory,
              },
            }
          : {}),
      },
    });
  }
  return out;
}

/** What node a scale-out would create, derived from the observed pool. */
function specForScaleOut(pool: PoolEntry[], defaultEdge: string | null) {
  const appPool = pool.filter((p) => nodeHostsContainers(p.observation.role));
  // Every cluster routes through one dedicated edge; scale-out only ever adds
  // app nodes behind it. Resolve it from cluster.json, else the pool's single
  // edge-role node (autoscale never provisions an edge — deploy does).
  const edgeNodeId =
    defaultEdge ?? pool.find((p) => nodeFrontsIngress(p.entry.role))?.entry.nodeId ?? null;
  if (edgeNodeId === null) {
    throw new CliError(`cluster has no edge node to front a new app node`, {
      hint: "run `launchpad deploy` once to provision the cluster's dedicated edge",
    });
  }
  return scaleOutNodeSpec({
    existingNodeIds: pool.map((p) => p.entry.nodeId),
    pool: appPool.map((p) => ({ nodeId: p.entry.nodeId, instanceType: p.entry.instanceType })),
    defaultEdge: edgeNodeId,
  });
}

async function applyScaleOut(
  aws: AwsEnv,
  spec: ReturnType<typeof specForScaleOut>,
  opts: RunOptions,
): Promise<string> {

  const capacity = await resolveCapacity(aws, spec.instanceType);
  const ami = await resolveNodeAmi({
    ec2: aws.ec2,
    ssm: aws.ssm,
    region: aws.region,
    role: spec.role === "app" ? "app" : "edge",
  });
  const vpcId = await getDefaultVpcId(aws.ec2);

  const spin = isJsonMode() ? null : spinner(`provisioning ${spec.nodeId}…`).start();
  try {
    await provisionNode({
      aws,
      nodeId: spec.nodeId,
      role: spec.role,
      instanceType: spec.instanceType,
      agentVersion: readVersion(),
      capacity,
      amiId: ami.imageId,
      amiBootstrapMode: ami.bootstrapMode,
      vpcId,
      ...(spec.edgeNodeId !== null ? { edgeNodeId: spec.edgeNodeId } : {}),
      onProgress: (t) => {
        if (spin) spin.text = t;
      },
    });
    spin?.succeed(`launched ${spec.nodeId} (${spec.instanceType}, role ${spec.role})`);
  } catch (error) {
    spin?.fail(`provisioning ${spec.nodeId} failed`);
    throw error;
  }

  // Spread the footprint onto the new node. Convergence is eventual (the fresh
  // node's agent picks the placement up once it boots) — same contract as rebalance.
  await runRebalance({
    ...pickGlobalOpts(opts),
    env: opts.env,
    yes: true,
    quiet: true,
  });
  return spec.nodeId;
}

async function applyScaleIn(aws: AwsEnv, pool: PoolEntry[], victim: string, opts: RunOptions): Promise<void> {
  const target = pool.find((p) => p.entry.nodeId === victim);
  if (!target) throw new CliError(`scale-in victim "${victim}" vanished from the registry`);

  // Evacuate this project's cluster-placed services and WAIT for the survivors to
  // converge — never terminate a node whose replicas aren't confirmed up elsewhere.
  await runRebalance({
    ...pickGlobalOpts(opts),
    env: opts.env,
    drainNodes: [victim],
    yes: true,
    wait: true,
    quiet: true,
    ...(opts.timeout !== undefined ? { timeout: parseIntOpt(opts.timeout, "--timeout") } : {}),
  });

  // Orphan gate: anything still scheduled on the victim (another project's services,
  // or a pinned service) must block the teardown — autoscale never orphans workloads.
  const desired = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, victim));
  const leftover = desired ? parseDesiredState(desired.raw).services : [];
  if (leftover.length > 0) {
    const names = leftover.map((s) => `${s.project}/${s.service}`).join(", ");
    throw new CliError(`scale-in aborted: ${victim} still hosts ${names}`, {
      hint: "nothing was torn down — move or destroy those services, or lower maxNodes expectations",
    });
  }

  // Drain grace: the desired state is empty, but the victim's AGENT must reconcile it
  // (graceful container stop + upstream-shard retraction) before the instance dies —
  // otherwise an edge keeps routing to the dead IP. Best-effort with a timeout: the
  // replicas are already confirmed up elsewhere, only graceful shutdown is at stake.
  const drainSpin = isJsonMode() ? null : spinner(`waiting for ${victim}'s agent to drain…`).start();
  const drained = await waitForVictimDrained(aws, victim, 120_000);
  if (drained) drainSpin?.succeed(`${victim} drained cleanly`);
  else {
    drainSpin?.warn(`${victim} didn't confirm the drain in time — terminating anyway`);
    log.warn(`node "${victim}" didn't confirm the drain — its containers get a hard stop`);
  }

  // Re-run the orphan gate at the last instant: a concurrent deploy could have placed
  // services onto the victim during the drain-grace window (its registry entry is still
  // live to other commands' planners). Cheap second read; aborting here loses nothing.
  const recheck = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, victim));
  const reappeared = recheck ? parseDesiredState(recheck.raw).services : [];
  if (reappeared.length > 0) {
    const names = reappeared.map((s) => `${s.project}/${s.service}`).join(", ");
    throw new CliError(`scale-in aborted: a concurrent deploy placed ${names} on ${victim}`, {
      hint: "nothing was torn down — re-run autoscale after the deploy settles",
    });
  }

  const spin = isJsonMode() ? null : spinner(`terminating ${victim}…`).start();
  try {
    await teardownNode(aws, target.entry, {
      text: (t) => {
        if (spin) spin.text = t;
      },
      warn: (m) => log.warn(m),
    });
    spin?.succeed(`scaled in ${victim}`);
  } catch (error) {
    spin?.fail(`teardown of ${victim} failed`);
    throw error;
  }
}

/**
 * Wait for the victim's agent to report NOTHING running (its desired.json is empty by
 * the orphan gate, so a reconciled status has zero running replicas across all projects).
 * Returns false on timeout — the caller proceeds, accepting a hard container stop.
 */
async function waitForVictimDrained(aws: AwsEnv, nodeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
    if (obj) {
      try {
        const status = parseNodeStatus(obj.raw);
        if (status.services.every((s) => s.runningReplicas === 0)) return true;
      } catch {
        /* malformed status — keep polling */
      }
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function runAutoscale(opts: RunOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const { cfg } = await requireCluster(aws);
  if (!cfg.autoscale) {
    throw new CliError(`cluster "${aws.clusterId}" has no autoscale policy`, {
      hint: "set one first: launchpad autoscale set --min 1 --max 3",
    });
  }

  const nowMs = Date.now();
  const pool = await observePool(aws, cfg.defaultEdge, nowMs);
  const decision = planAutoscale({
    policy: cfg.autoscale,
    nodes: pool.map((p) => p.observation),
    nowMs,
  });

  if (decision.action === "none") {
    if (isJsonMode()) printJson({ cluster: aws.clusterId, action: "none", reason: decision.reason });
    else log.success(`nothing to do — ${decision.reason}`);
    return;
  }

  if (opts.dryRun === true) {
    const planned =
      decision.action === "scale-out"
        ? { action: decision.action, reason: decision.reason }
        : { action: decision.action, victim: decision.victim, reason: decision.reason };
    if (isJsonMode()) printJson({ cluster: aws.clusterId, dryRun: true, ...planned });
    else {
      panel("Autoscale (dry run)", [
        `would ${color.cyan(decision.action)}${decision.action === "scale-in" ? ` ${color.cyan(decision.victim)}` : ""}`,
        color.dim(decision.reason),
      ]);
    }
    return;
  }

  // Applying either action needs the project's launch-pad.toml (the rebalance step
  // replans this project's cluster-placed services over the new pool).
  if (!findConfigPath(process.cwd())) {
    throw new CliError("autoscale run needs your project's launch-pad.toml to rebalance the footprint", {
      hint: "run it from your project directory (or a parent)",
    });
  }

  if (!isJsonMode()) log.step(`autoscale: ${decision.action} — ${decision.reason}`);

  // Spend/teardown gate: both actions are billable or destructive. `--yes` (cron)
  // skips the prompt; non-interactive (--json) mode must opt in explicitly.
  const spec = decision.action === "scale-out" ? specForScaleOut(pool, cfg.defaultEdge) : null;
  if (opts.yes !== true) {
    if (isJsonMode()) {
      throw new CliError("autoscale run needs --yes to apply scale actions in --json mode", {
        hint: "pass --yes (cron/CI), or run interactively to confirm",
      });
    }
    const ok = await confirm(
      spec !== null
        ? `launch a ${color.cyan(spec.instanceType)} EC2 instance as ${color.cyan(spec.nodeId)} (billed hourly)?`
        : `drain ${color.cyan((decision as { victim: string }).victim)} onto the surviving pool and terminate it?`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  // Claim the action BEFORE the irreversible steps: CAS-stamp `lastScaleAt` so an
  // overlapping pass (slow cron fire, two operators) sees the cooldown and no-ops,
  // and a pass that crashes mid-action can't relaunch instances every cron interval.
  // A concurrent cluster.json write (set-edge, autoscale set, another run) loses the
  // CAS and this pass aborts having changed nothing.
  await claimScaleAction(aws, nowMs);

  let result: Record<string, unknown>;
  if (spec !== null) {
    const nodeId = await applyScaleOut(aws, spec, opts);
    result = { cluster: aws.clusterId, action: "scale-out", node: nodeId, reason: decision.reason };
  } else {
    const victim = (decision as { victim: string }).victim;
    try {
      await applyScaleIn(aws, pool, victim, opts);
    } catch (error) {
      if (error instanceof EvacuationBlockedError) {
        // Pinned service on the victim / last app node — nothing moved, nothing destroyed.
        if (isJsonMode()) {
          printJson({ cluster: aws.clusterId, action: "none", blocked: true, reason: error.message });
        } else {
          log.warn(`scale-in blocked: ${error.message}`);
        }
        return;
      }
      throw error;
    }
    result = { cluster: aws.clusterId, action: "scale-in", node: victim, reason: decision.reason };
  }

  if (isJsonMode()) printJson(result);
  else {
    log.success(
      decision.action === "scale-out"
        ? `scaled out — node ${color.cyan(String(result.node))} added; agents converge on their next poll`
        : `scaled in — node ${color.cyan(String(result.node))} drained and terminated`,
    );
  }
}

/**
 * CAS-stamp `lastScaleAt` in cluster.json before acting. The conditional PUT (ifMatch
 * on the etag read here) makes the claim exclusive: of two overlapping passes only one
 * wins; the loser aborts with nothing changed. The early stamp also means a pass that
 * fails mid-action leaves the cooldown in place (no instance-launch storm on cron retry).
 */
async function claimScaleAction(aws: AwsEnv, nowMs: number): Promise<void> {
  const obj = await getJson(aws.s3, aws.bucket, clusterConfigKey(aws.clusterId));
  if (!obj) throw new CliError(`cluster "${aws.clusterId}" vanished — nothing was changed`);
  const cfg = parseClusterConfig(obj.raw);
  if (!cfg.autoscale) {
    throw new CliError("the autoscale policy was removed while this pass was planning — aborting", {
      hint: "nothing was changed; re-run if this is unexpected",
    });
  }
  try {
    await putJson(
      aws.s3,
      aws.bucket,
      clusterConfigKey(aws.clusterId),
      { ...cfg, autoscale: { ...cfg.autoscale, lastScaleAt: new Date(nowMs).toISOString() } },
      { ifMatch: obj.etag },
    );
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      throw new CliError("another autoscale pass (or cluster edit) is in flight — aborting", {
        hint: "nothing was changed; the other writer wins. Re-run after it finishes",
      });
    }
    throw error;
  }
}

/** The subset of options `runRebalance` reads to resolve its AWS target. */
function pickGlobalOpts(opts: GlobalOpts): GlobalOpts {
  return {
    profile: opts.profile,
    region: opts.region,
    cluster: opts.cluster,
    json: opts.json,
    verbose: opts.verbose,
  };
}

export function registerAutoscale(program: Command): void {
  const autoscale = program
    .command("autoscale")
    .description("Reactive node-pool autoscaling: declarative min/max app nodes + utilization thresholds");

  const set = autoscale
    .command("set")
    .description("Save the cluster's autoscale policy (stored in cluster.json)")
    .requiredOption("--min <n>", "minimum app nodes (maintained even when idle)")
    .requiredOption("--max <n>", "maximum app nodes (utilization never grows past this)")
    .option("--scale-out-percent <p>", "scale out when avg pool cpu/memory ≥ this % (default 80)")
    .option("--scale-in-percent <p>", "scale in when every node is below this % (default 30)")
    .option("--cooldown <seconds>", "minimum seconds between utilization actions (default 300)")
    .action(async (_o, command: Command) => {
      await runSet(mergedOpts<SetOptions>(command));
    });
  applyGlobalOptions(set);

  const show = autoscale
    .command("show")
    .description("Show the cluster's autoscale policy")
    .action(async (_o, command: Command) => {
      await runShow(mergedOpts<GlobalOpts>(command));
    });
  applyGlobalOptions(show);

  const off = autoscale
    .command("off")
    .description("Disable autoscaling for the cluster (clears the policy)")
    .action(async (_o, command: Command) => {
      await runOff(mergedOpts<GlobalOpts>(command));
    });
  applyGlobalOptions(off);

  const run = autoscale
    .command("run")
    .description("One reconcile pass: observe the pool, apply at most one scale action, exit")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--dry-run", "report the planned action without changing anything")
    .option("--yes", "skip the confirmation prompts (required for cron/CI)")
    .option("--timeout <seconds>", "scale-in drain convergence timeout (default 300)")
    .addHelpText(
      "after",
      [
        "",
        "Autoscaling is a *reconcile pass*, not a daemon: each `run` reads the policy from",
        "cluster.json, observes live host CPU/memory (embedded in each node's status.json),",
        "and applies at most ONE action — provision a new app node and rebalance onto",
        "it, or drain the least-utilized node (waiting for convergence) and terminate it.",
        "Cron it for hands-off scaling, e.g. every 5 minutes:",
        "",
        "  */5 * * * *  cd /path/to/project && launchpad autoscale run --yes --cluster prod",
        "",
        "Safety: the minNodes floor always holds; scale-in refuses to touch the cluster's",
        "default edge, anything still hosting another project's (or a pinned) service, and",
        "never acts on stale metrics. A cooldown (default 300s) separates utilization actions.",
      ].join("\n"),
    )
    .action(async (_o, command: Command) => {
      await runAutoscale(mergedOpts<RunOptions>(command));
    });
  applyGlobalOptions(run);
}
