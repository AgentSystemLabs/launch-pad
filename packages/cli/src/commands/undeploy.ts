import { Command } from "commander";
import {
  configBaselineKey,
  desiredKey,
  edgeConfigKey,
  envProject,
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  LABEL_REGEX,
  PROTOCOL_VERSION,
  parseConfigBaseline,
  parseDesiredState,
  parseNodeStatus,
  planUndeploy,
  removeServicesFromBaseline,
  secretParameterPrefix,
  servicesAfterRemoval,
  statusKey,
  type DesiredState,
  type UndeployPlan,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { awsErrorName } from "../aws/errors";
import { deleteObject, getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { deleteSecretParameter, listSecretsByPrefix } from "../aws/ssm-secrets";
import { loadNodeDesiredStates, type NodeDesiredState } from "../deploy/deployed-footprint";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

/** Optimistic-concurrency retries when removing a project from a node's desired.json. */
const MAX_PUBLISH_RETRIES = 5;
/** Default time `undeploy` waits for the agent to stop the removed containers. */
const DEFAULT_DRAIN_TIMEOUT_SECONDS = 120;
const DRAIN_POLL_MS = 4000;

export interface UndeployOptions extends GlobalOpts {
  /** Remove only this service of the footprint (default: the whole project footprint). */
  service?: string;
  /** Target a named environment footprint (symmetric with `deploy --env`). */
  env?: string;
  /** Also delete the removed services' SSM SecureString secrets (default: keep them). */
  purgeSecrets?: boolean;
  yes?: boolean;
  /** commander sets this false for `--no-wait` (undeploy waits for drain by default). */
  wait?: boolean;
  timeout?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What `applyUndeploy` did, for the report + the follow-up secret purge / drain wait. */
export interface UndeployResult {
  /** Nodes whose desired.json was rewritten. */
  nodes: string[];
  /** Distinct footprint services removed. */
  removedServices: string[];
  /** True when the config baseline was deleted (whole footprint or its last service gone). */
  baselineCleared: boolean;
  /** Edges whose advisory edge.json was pruned. */
  prunedEdges: string[];
}

/** Read → drop the footprint's removed services → conditional write, retrying on a CAS loss. */
async function publishRemoval(
  aws: AwsEnv,
  nodeId: string,
  ownerProject: string,
  removeSet: Set<string> | null,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
    if (!existing) return; // node already has no desired.json — nothing to remove
    const state = parseDesiredState(existing.raw);
    const services = servicesAfterRemoval(state.services, ownerProject, removeSet);
    if (services.length === state.services.length) return; // nothing of ours here anymore

    const next: DesiredState = { version: PROTOCOL_VERSION, nodeId, updatedAt: nowIso(), services };
    try {
      await putJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId), next, {
        ifMatch: existing.etag,
      });
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  throw new CliError(`could not update desired state for node "${nodeId}"`, {
    hint: "a concurrent deploy may be racing this node — try again",
  });
}

/** Best-effort: drop now-unserved domains from an edge's advisory edge.json (never fails undeploy). */
async function pruneEdgeConfig(aws: AwsEnv, edgeId: string, removedDomains: string[]): Promise<boolean> {
  if (removedDomains.length === 0) return false;
  const drop = new Set(removedDomains);
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, edgeConfigKey(aws.clusterId, edgeId));
    if (!existing) return false;
    const current = (existing.raw as { domains?: string[] } | undefined)?.domains ?? [];
    const next = current.filter((d) => !drop.has(d));
    if (next.length === current.length) return false;
    try {
      await putJson(
        aws.s3,
        aws.bucket,
        edgeConfigKey(aws.clusterId, edgeId),
        { nodeId: edgeId, domains: next, updatedAt: nowIso() },
        { ifMatch: existing.etag },
      );
      return true;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  return false;
}

/**
 * Drop the removed services from the config baseline (or delete it when nothing remains).
 *
 * Every read-modify-write is ETag-guarded so a concurrent `deploy` re-recording the same
 * footprint's baseline can't be silently clobbered — which would otherwise unlock the
 * config-lock identity guard for a live, re-added service. The whole-footprint delete is
 * conditional and, on a precondition miss, LEAVES the baseline in place (a racing deploy
 * just wrote it, likely re-adding the footprint) rather than blindly deleting it.
 */
async function updateBaseline(
  aws: AwsEnv,
  ownerProject: string,
  removeWholeFootprint: boolean,
  removedServices: string[],
): Promise<boolean> {
  const key = configBaselineKey(aws.clusterId, ownerProject);

  if (removeWholeFootprint) {
    const obj = await getJson(aws.s3, aws.bucket, key);
    if (!obj) return true; // already absent — the footprint is unlocked
    try {
      await deleteObject(aws.s3, aws.bucket, key, { ifMatch: obj.etag });
      return true;
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        log.warn(`config baseline for "${ownerProject}" changed concurrently — left in place`);
        return false;
      }
      throw error;
    }
  }

  // Partial: trim the removed services, CAS-retrying on a concurrent baseline write.
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const obj = await getJson(aws.s3, aws.bucket, key);
    if (!obj) return false; // no baseline file (lock reconstructs from desired) — nothing to edit
    let baseline;
    try {
      baseline = parseConfigBaseline(obj.raw);
    } catch {
      // A corrupt baseline: delete it so the next deploy re-records a clean one rather
      // than tripping the lock against an unreadable snapshot.
      try {
        await deleteObject(aws.s3, aws.bucket, key, { ifMatch: obj.etag });
        return true;
      } catch (error) {
        if (error instanceof PreconditionFailedError) continue;
        throw error;
      }
    }
    const next = removeServicesFromBaseline(baseline, removedServices);
    try {
      if (next === null) {
        await deleteObject(aws.s3, aws.bucket, key, { ifMatch: obj.etag });
        return true;
      }
      await putJson(aws.s3, aws.bucket, key, next, { ifMatch: obj.etag });
      return false;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  log.warn(`config baseline for "${ownerProject}" kept being written concurrently — left as-is`);
  return false;
}

/**
 * Apply a planned undeploy to S3: remove the footprint's services from each affected
 * node's desired.json, prune advisory edge.json, and update/delete the config baseline.
 * Pure side-effects on S3 (no prompts, secret purge, or drain wait) so it's unit-testable.
 */
export async function applyUndeploy(
  aws: AwsEnv,
  ownerProject: string,
  servicesToRemove: string[] | null,
  plan: UndeployPlan,
): Promise<UndeployResult> {
  const removeSet = servicesToRemove === null ? null : new Set(servicesToRemove);

  for (const node of plan.nodes) {
    await publishRemoval(aws, node.nodeId, ownerProject, removeSet);
  }

  const prunedEdges: string[] = [];
  for (const edgeId of plan.affectedEdges) {
    if (await pruneEdgeConfig(aws, edgeId, plan.removedDomains)) prunedEdges.push(edgeId);
  }

  const baselineCleared = await updateBaseline(
    aws,
    ownerProject,
    servicesToRemove === null,
    plan.removedServices,
  );

  return {
    nodes: plan.nodes.map((n) => n.nodeId),
    removedServices: plan.removedServices,
    baselineCleared,
    prunedEdges,
  };
}

/** True when a node's status.json no longer reports the removed services as running. */
export function drained(statusRaw: unknown, ownerProject: string, removeSet: Set<string> | null): boolean {
  let status;
  try {
    status = parseNodeStatus(statusRaw);
  } catch {
    return false;
  }
  return !status.services.some(
    (s) =>
      s.project === ownerProject &&
      (removeSet === null || removeSet.has(s.service)) &&
      (s.runningReplicas > 0 || s.replicas.some((r) => r.state === "running")),
  );
}

/** Whether a node's heartbeat is stale (or unreadable) — i.e. no live agent to drain it. */
function heartbeatStale(statusRaw: unknown): boolean {
  try {
    return isHeartbeatStale(parseNodeStatus(statusRaw).lastSeen, Date.now(), HEARTBEAT_STALE_MS);
  } catch {
    return true;
  }
}

export interface DrainResult {
  /** Every affected node reported the removed services stopped. */
  drained: boolean;
  /** Nodes that aren't reporting a live heartbeat — drain can't be confirmed for these. */
  unreachable: string[];
}

/** Poll affected nodes until the agent has stopped the removed containers (or the timeout). */
async function waitForDrain(
  aws: AwsEnv,
  nodeIds: string[],
  ownerProject: string,
  removeSet: Set<string> | null,
  timeoutMs: number,
): Promise<DrainResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(
      nodeIds.map(async (id) => ({
        id,
        obj: await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, id)),
      })),
    );
    // No status (or unreadable) → treat as not-yet-drained until the deadline.
    if (statuses.every(({ obj }) => (obj ? drained(obj.raw, ownerProject, removeSet) : false))) {
      return { drained: true, unreachable: [] };
    }
    if (Date.now() >= deadline) {
      // Distinguish "agent alive, still draining" from "no live agent will ever drain it".
      const unreachable = statuses
        .filter(({ obj }) => !obj || heartbeatStale(obj.raw))
        .map(({ id }) => id);
      return { drained: false, unreachable };
    }
    await sleep(DRAIN_POLL_MS);
  }
}

/** Delete every SSM secret under each removed service's footprint prefix (opt-in, best-effort). */
async function purgeSecrets(
  aws: AwsEnv,
  ownerProject: string,
  services: string[],
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];
  for (const service of services) {
    // Defense-in-depth: a service name comes from published desired.json (validated as a
    // label at deploy time, but only `min(1)` on the wire). Refuse to build an SSM purge
    // prefix from a name carrying hierarchy-breaking characters (`/`, `*`, whitespace),
    // which could otherwise scope the GetParametersByPath/Delete outside this footprint.
    if (!/^[A-Za-z0-9_.-]+$/.test(service)) {
      failed.push(`${service}: refusing to purge — unexpected characters in service name`);
      continue;
    }
    const prefix = secretParameterPrefix({ clusterId: aws.clusterId, ownerProject, service });
    let listed;
    try {
      listed = await listSecretsByPrefix(aws.ssm, prefix);
    } catch (error) {
      failed.push(`${service}: ${(error as Error).message}`);
      continue;
    }
    for (const s of listed) {
      try {
        await deleteSecretParameter(aws.ssm, s.path);
        deleted += 1;
      } catch (error) {
        failed.push(`${service}/${s.name}: ${(error as Error).message}`);
      }
    }
  }
  return { deleted, failed };
}

function resolveTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DRAIN_TIMEOUT_SECONDS * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, { hint: "pass whole seconds ≥ 1, e.g. --timeout 120" });
  }
  return seconds * 1000;
}

export async function runUndeploy(opts: UndeployOptions): Promise<void> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run undeploy from your project directory (or a parent)",
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

  const aws = await prepareAws(opts);
  log.step(
    `cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`,
  );
  if (env !== undefined) {
    log.step(`environment ${color.cyan(env)} · footprint ${color.cyan(ownerProject)}`);
  }

  // Read every node's desired state (empty when the bucket doesn't exist yet).
  let states: NodeDesiredState[];
  try {
    states = await loadNodeDesiredStates(aws.s3, aws.bucket, aws.clusterId);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") states = [];
    else throw error;
  }

  // Validate --service against what is actually deployed for this footprint.
  const deployedNames = new Set(
    states.flatMap((s) => s.services.filter((x) => x.project === ownerProject).map((x) => x.service)),
  );
  let servicesToRemove: string[] | null = null;
  if (opts.service !== undefined) {
    if (!deployedNames.has(opts.service)) {
      throw new CliError(`service "${opts.service}" is not deployed for "${ownerProject}"`, {
        hint:
          deployedNames.size > 0
            ? `deployed services: ${[...deployedNames].sort().join(", ")}`
            : "nothing is deployed for this footprint",
      });
    }
    servicesToRemove = [opts.service];
  }

  const plan = planUndeploy(states, ownerProject, servicesToRemove);

  if (plan.nodes.length === 0) {
    if (isJsonMode()) {
      printJson({ undeployed: false, reason: "nothing-deployed", project: ownerProject });
      return;
    }
    log.info(
      opts.service
        ? `service "${opts.service}" is not deployed for ${color.cyan(ownerProject)} — nothing to undeploy`
        : `nothing is deployed for ${color.cyan(ownerProject)} — nothing to undeploy`,
    );
    return;
  }

  const removeSet = servicesToRemove === null ? null : new Set(servicesToRemove);
  const what = servicesToRemove === null ? `the whole ${ownerProject} footprint` : `${plan.removedServices.join(", ")}`;

  if (!isJsonMode()) {
    panel("Undeploy", [
      `${color.cyan(what)}`,
      `from ${plan.nodes.map((n) => color.cyan(n.nodeId)).join(", ")}`,
      ...(plan.removedDomains.length > 0
        ? [color.dim(`drops domains: ${plan.removedDomains.join(", ")}`)]
        : []),
      color.dim(
        servicesToRemove === null
          ? "the config baseline is cleared — the next deploy is a fresh first deploy"
          : "the config baseline drops these services — remove their [[service]] blocks from launch-pad.toml afterward",
      ),
      ...(opts.purgeSecrets
        ? [color.yellow("--purge-secrets: their SSM secrets are deleted (irreversible)")]
        : [color.dim("their SSM secrets are kept (pass --purge-secrets to delete them)")]),
      color.dim("ECR images are kept (immutable + content-addressed — preserves rollback)"),
    ]);
  }

  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`undeploy ${what}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const spin = isJsonMode() ? null : spinner("removing desired state…").start();
  let result: UndeployResult;
  try {
    result = await applyUndeploy(aws, ownerProject, servicesToRemove, plan);
    spin?.succeed(`removed ${color.cyan(what)} from ${result.nodes.length} node(s)`);
  } catch (error) {
    spin?.fail("undeploy failed");
    throw error;
  }

  // Wait for the agent to actually stop the containers (so the user sees it's gone).
  let drain: DrainResult = { drained: true, unreachable: [] };
  if (opts.wait !== false) {
    const drainSpin = isJsonMode() ? null : spinner("waiting for the agent to stop the containers…").start();
    drain = await waitForDrain(
      aws,
      plan.nodes.map((n) => n.nodeId),
      ownerProject,
      removeSet,
      resolveTimeoutMs(opts.timeout),
    );
    if (drain.drained) drainSpin?.succeed("containers stopped");
    else if (drain.unreachable.length > 0) {
      drainSpin?.warn(`can't confirm drain — node(s) not reporting: ${drain.unreachable.join(", ")}`);
    } else drainSpin?.warn("still draining — the agent will finish on its next poll");
  }

  // Opt-in secret purge — AFTER the drain wait so a still-running container's secrets
  // aren't yanked out from under it (best-effort; reported, never fatal).
  let secretsPurged: { deleted: number; failed: string[] } | null = null;
  if (opts.purgeSecrets) {
    secretsPurged = await purgeSecrets(aws, ownerProject, plan.removedServices);
  }

  if (isJsonMode()) {
    printJson({
      undeployed: true,
      project: ownerProject,
      removedServices: result.removedServices,
      nodes: result.nodes,
      removedDomains: plan.removedDomains,
      baselineCleared: result.baselineCleared,
      prunedEdges: result.prunedEdges,
      drained: opts.wait === false ? null : drain.drained,
      ...(drain.unreachable.length > 0 ? { unreachable: drain.unreachable } : {}),
      ...(secretsPurged ? { secretsPurged } : {}),
    });
    return;
  }

  if (secretsPurged) {
    if (secretsPurged.deleted > 0) log.success(`deleted ${secretsPurged.deleted} SSM secret(s)`);
    for (const f of secretsPurged.failed) log.warn(`secret purge: ${f}`);
  }
  if (servicesToRemove === null) {
    log.dim(`  the ${color.cyan(ownerProject)} footprint is fully removed — re-deploy to recreate it`);
  } else {
    log.dim(
      `  remove the ${plan.removedServices.map((s) => `[[service]] ${s}`).join(" / ")} block(s) from launch-pad.toml`,
    );
  }
}

export function registerUndeploy(program: Command): void {
  const cmd = program
    .command("undeploy")
    .description("Remove a project (or one service) from its nodes — the inverse of deploy")
    .option("--service <name>", "undeploy only this service (default: the whole project footprint)")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--purge-secrets", "also delete the removed services' SSM secrets (irreversible)")
    .option("--no-wait", "don't wait for the agent to stop the containers")
    .option("--timeout <seconds>", "how long to wait for the containers to stop", String(DEFAULT_DRAIN_TIMEOUT_SECONDS))
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "Undeploy is the sanctioned way to remove a service the config lock otherwise freezes:",
        "it drops the service(s) from each node's desired.json (the agent stops the containers),",
        "and trims the config baseline so a follow-up `deploy` of the edited launch-pad.toml (with",
        "the [[service]] block removed) passes the lock instead of failing on 'service removed'.",
        "",
        "With no --service it removes the whole project footprint and clears the baseline, so the",
        "next deploy is a fresh first deploy (identity unlocked again). Another project's services",
        "on the same node are never touched.",
        "",
        "ECR images are left in place (immutable + content-addressed; they preserve rollback and",
        "cost almost nothing). SSM secrets are kept unless you pass --purge-secrets.",
        "",
        "Examples:",
        "  $ launch-pad undeploy --service worker      # remove one service",
        "  $ launch-pad undeploy                        # remove the whole footprint",
        "  $ launch-pad undeploy --env staging --yes    # remove a named-env footprint",
        "  $ launch-pad undeploy --service api --purge-secrets",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runUndeploy(mergedOpts<UndeployOptions>(command));
    });

  applyGlobalOptions(cmd);
}
