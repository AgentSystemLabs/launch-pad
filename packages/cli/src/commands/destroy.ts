/**
 * `launchpad destroy` — the inverse of `deploy`, for app footprints (infrastructure
 * teardown stays under `node destroy` / `cluster destroy`).
 *
 *   destroy                       remove the whole base footprint (needs launch-pad.toml)
 *   destroy --service worker      remove one service from the footprint
 *   destroy --env pr-123          full env teardown: undeploy + S3 state
 *   destroy --list-envs           enumerate env footprints created by `deploy --env`
 *   destroy --prune-expired       show TTL-expired envs (add --yes to destroy them)
 *
 * Named environments are registered by `deploy --env` via each footprint's
 * `projects/<owner>/preview.json` marker (shared/src/preview.ts — internal S3 contract;
 * the agent never reads it). Env destroy = undeploy the whole env footprint (reusing the
 * undeploy planner/applier, so co-located siblings from OTHER footprints are never
 * touched) → wait for the drain → sweep the footprint's `projects/<owner>/` state.
 * DNS is user-managed (a wildcard at the edge keeps covering live envs), so teardown
 * never touches it. `--prune-expired` is one cron-able pass (no daemon), symmetric
 * with `autoscale run`.
 */
import { Command } from "commander";
import {
  configBaselineKey,
  desiredKey,
  edgeConfigKey,
  footprintOwner,
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  isPreviewExpired,
  LABEL_REGEX,
  PROTOCOL_VERSION,
  parseConfigBaseline,
  parseDesiredState,
  parseNodeStatus,
  planPreviewPrune,
  planUndeploy,
  projectIndexKey,
  projectStatePrefix,
  removeServicesFromBaseline,
  secretParameterPrefix,
  selectPreviewMarkers,
  servicesAfterRemoval,
  statusKey,
  type DesiredState,
  type PreviewMarker,
  type UndeployPlan,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { awsErrorName } from "../aws/errors";
import {
  deleteObject,
  deletePrefix,
  getJson,
  PreconditionFailedError,
  putJson,
} from "../aws/s3-state";
import { deleteSecretParameter, listSecretsByPrefix } from "../aws/ssm-secrets";
import { loadNodeDesiredStates, type NodeDesiredState } from "../deploy/deployed-footprint";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { resolveTimeoutSecondsMs } from "../timeout";
import { loadEnvMarkers } from "../preview/markers";
import { loadProjectIndex, removeFromProjectIndex } from "../project/registry";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

/** Optimistic-concurrency retries when removing a project from a node's desired.json. */
const MAX_PUBLISH_RETRIES = 5;
/** Default time `destroy` waits for the agent to stop the removed containers. */
const DEFAULT_DRAIN_TIMEOUT_SECONDS = 120;
const DRAIN_POLL_MS = 4000;

/**
 * A marker's owner names the `projects/<owner>/` prefix the env destroy path sweeps.
 * The schema already pins owner = project + "-" + env, but the marker is read back
 * from S3 — never build a delete prefix from a value that could carry `/` or other
 * hierarchy-breaking characters.
 */
const OWNER_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export interface DestroyOptions extends GlobalOpts {
  /** Remove only this service of the footprint (default: the whole project footprint). */
  service?: string;
  /** Target a named environment footprint (symmetric with `deploy --env`). */
  env?: string;
  /** Base project an env belongs to (disambiguation / --list-envs filter), or a whole-project fan-out target. */
  project?: string;
  /** Component the env belongs to (disambiguation when a project's components share an env name). */
  component?: string;
  /** Enumerate env footprints instead of destroying anything. */
  listEnvs?: boolean;
  /** Destroy every TTL-expired env (dry-run without --yes). */
  pruneExpired?: boolean;
  /** Also delete the removed services' SSM SecureString secrets (default: keep them). */
  purgeSecrets?: boolean;
  yes?: boolean;
  /** commander sets this false for `--no-wait` (destroy waits for drain by default). */
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

/** Best-effort: drop now-unserved domains from an edge's advisory edge.json (never fails destroy). */
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
export async function waitForDrain(
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

/** Read every node's desired state (empty when the bucket doesn't exist yet). */
async function loadStates(aws: AwsEnv): Promise<NodeDesiredState[]> {
  try {
    return await loadNodeDesiredStates(aws.s3, aws.bucket, aws.clusterId);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Footprint destroy (base project, or --service partial, or --env + --service)
// ---------------------------------------------------------------------------

/** The base/partial path: plan + apply an undeploy of the launch-pad.toml footprint. */
async function runFootprintDestroy(opts: DestroyOptions): Promise<void> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run destroy from your project directory (or a parent)",
    });
  }
  const { config } = loadConfig();

  const env = opts.env;
  const ownerProject = footprintOwner(config, env);

  const aws = await prepareAws(opts);
  log.step(
    `cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`,
  );
  if (env !== undefined) {
    log.step(`environment ${color.cyan(env)} · footprint ${color.cyan(ownerProject)}`);
  }

  const states = await loadStates(aws);

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
      printJson({ destroyed: false, reason: "nothing-deployed", project: ownerProject });
      return;
    }
    log.info(
      opts.service
        ? `service "${opts.service}" is not deployed for ${color.cyan(ownerProject)} — nothing to destroy`
        : `nothing is deployed for ${color.cyan(ownerProject)} — nothing to destroy`,
    );
    return;
  }

  const removeSet = servicesToRemove === null ? null : new Set(servicesToRemove);
  const what = servicesToRemove === null ? `the whole ${ownerProject} footprint` : `${plan.removedServices.join(", ")}`;

  if (!isJsonMode()) {
    panel("Destroy", [
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
    const ok = await confirm(`destroy ${what}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const spin = isJsonMode() ? null : spinner("removing desired state…").start();
  let result: UndeployResult;
  try {
    result = await applyUndeploy(aws, ownerProject, servicesToRemove, plan);
    spin?.succeed(`removed ${color.cyan(what)} from ${result.nodes.length} node(s)`);
  } catch (error) {
    spin?.fail("destroy failed");
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
      resolveTimeoutSecondsMs(opts.timeout, DEFAULT_DRAIN_TIMEOUT_SECONDS),
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

  // A whole BASE-footprint destroy unregisters the component from the project's
  // index (env teardowns don't — the base component still exists).
  if (servicesToRemove === null && env === undefined) {
    await removeFromProjectIndex(aws, config.project, config.component);
  }

  if (isJsonMode()) {
    printJson({
      destroyed: true,
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

// ---------------------------------------------------------------------------
// Environment teardown (--env, --list-envs, --prune-expired) — marker-driven
// ---------------------------------------------------------------------------

/**
 * The project (+ component) to scope by: --project/--component, else the
 * launch-pad.toml in cwd, else none. The component matters for disambiguation —
 * two components of one project can both have an env named `pr-1`.
 */
function defaultProjectScope(opts: {
  project?: string | undefined;
  component?: string | undefined;
}): { project: string | undefined; component: string | undefined } {
  if (opts.project !== undefined) return { project: opts.project, component: opts.component };
  if (!findConfigPath(process.cwd())) return { project: undefined, component: opts.component };
  try {
    const { config } = loadConfig();
    return { project: config.project, component: opts.component ?? config.component };
  } catch {
    return { project: undefined, component: opts.component };
  }
}

interface EnvDestroyReport {
  env: string;
  project: string;
  owner: string;
  /** Nodes whose desired.json dropped the footprint (empty when nothing was deployed). */
  nodes: string[];
  /** Drain result, or null when not waited / nothing to drain. */
  drained: boolean | null;
  /** S3 objects swept from the footprint's projects/ prefix. */
  sweptObjects: number;
  /** Opt-in SSM secret purge result (null unless --purge-secrets). */
  secretsPurged: { deleted: number; failed: string[] } | null;
}

/** Tear one env down end-to-end. Throws only on the undeploy publish path. */
async function destroyEnvFootprint(
  aws: AwsEnv,
  marker: PreviewMarker,
  opts: { wait: boolean; timeoutMs: number; purgeSecrets: boolean },
): Promise<EnvDestroyReport> {
  if (!OWNER_REGEX.test(marker.owner)) {
    throw new CliError(`refusing to destroy "${marker.owner}" — unexpected characters in the footprint name`);
  }

  // The marker is the CLAIM that `deploy --env` created this footprint; the config
  // baseline is deploy-written ground truth for which BASE project owns it. A mismatch
  // means a forged/corrupt marker is aimed at someone else's footprint (e.g. project
  // "my" + env "app" colliding with a production project named "my-app") — fail closed.
  const baselineObj = await getJson(aws.s3, aws.bucket, configBaselineKey(aws.clusterId, marker.owner));
  if (baselineObj) {
    let baselineProject: string;
    try {
      baselineProject = parseConfigBaseline(baselineObj.raw).project;
    } catch {
      throw new CliError(`refusing to destroy "${marker.owner}" — its config baseline is unreadable, so ownership can't be verified`, {
        hint: "re-deploy the env (which re-records the baseline), then destroy it again",
      });
    }
    if (baselineProject !== marker.project) {
      throw new CliError(
        `refusing to destroy "${marker.owner}" — its config baseline belongs to project "${baselineProject}", not "${marker.project}"`,
        { hint: "the env marker doesn't match the deployed footprint; remove the bogus marker or investigate the bucket writes" },
      );
    }
  }

  const states = await loadStates(aws);
  const plan = planUndeploy(states, marker.owner, null);

  let drainedResult: boolean | null = null;
  if (plan.nodes.length > 0) {
    await applyUndeploy(aws, marker.owner, null, plan);
    if (opts.wait) {
      const res = await waitForDrain(
        aws,
        plan.nodes.map((n) => n.nodeId),
        marker.owner,
        null,
        opts.timeoutMs,
      );
      drainedResult = res.drained;
    }
  }

  // Opt-in secret purge — after the drain wait, before the state sweep (best-effort).
  let secretsPurged: { deleted: number; failed: string[] } | null = null;
  if (opts.purgeSecrets) {
    secretsPurged = await purgeSecrets(aws, marker.owner, plan.removedServices);
  }

  // Sweep the footprint's per-project state: the marker itself, deploy events, and
  // any config-baseline remnant (applyUndeploy already cleared the baseline).
  const sweptObjects = await deletePrefix(
    aws.s3,
    aws.bucket,
    projectStatePrefix(aws.clusterId, marker.owner),
  );

  return {
    env: marker.env,
    project: marker.project,
    owner: marker.owner,
    nodes: plan.nodes.map((n) => n.nodeId),
    drained: drainedResult,
    sweptObjects,
    secretsPurged,
  };
}

function describeMarker(m: PreviewMarker, nowMs: number): string {
  const expiry =
    m.expiresAt === null
      ? "no TTL"
      : isPreviewExpired(m, nowMs)
        ? `EXPIRED ${m.expiresAt}`
        : `expires ${m.expiresAt}`;
  const who = m.component !== undefined ? `${m.project} · ${m.component}` : m.project;
  return `${who} · env ${m.env} · ${expiry}`;
}

async function runListEnvs(opts: DestroyOptions): Promise<void> {
  const aws = await prepareAws(opts);
  // --project alone filters the whole logical project (all components); the cwd
  // TOML's component is NOT applied here so a component repo still sees its
  // siblings' envs in the listing.
  const project = opts.project ?? defaultProjectScope({ component: opts.component }).project;
  let markers = await loadEnvMarkers(aws);
  if (project !== undefined) markers = markers.filter((m) => m.project === project);
  if (opts.component !== undefined) markers = markers.filter((m) => m.component === opts.component);
  const nowMs = Date.now();

  if (isJsonMode()) {
    printJson({
      envs: markers.map((m) => ({ ...m, expired: isPreviewExpired(m, nowMs) })),
    });
    return;
  }
  if (markers.length === 0) {
    log.info(
      project !== undefined
        ? `no environments for ${color.cyan(project)} — create one with \`launchpad deploy --env <name>\``
        : "no environments in this cluster — create one with `launchpad deploy --env <name>`",
    );
    return;
  }
  panel(
    "Environments",
    markers.map((m) => {
      const line = describeMarker(m, nowMs);
      const domains = m.domains.length > 0 ? `  ${color.dim(m.domains.join(", "))}` : "";
      return (isPreviewExpired(m, nowMs) ? color.yellow(line) : line) + domains;
    }),
  );
  log.dim("  destroy one: launchpad destroy --env <name> · reap expired: launchpad destroy --prune-expired --yes");
}

function reportEnvDestroy(r: EnvDestroyReport, wait: boolean): void {
  log.success(
    r.nodes.length > 0
      ? `removed ${color.cyan(r.owner)} from ${r.nodes.map((n) => color.cyan(n)).join(", ")}`
      : `${color.cyan(r.owner)} had nothing deployed — cleaned up its state`,
  );
  if (wait && r.nodes.length > 0) {
    if (r.drained === true) log.success("containers stopped");
    else log.warn("still draining — the agent will finish on its next poll");
  }
  if (r.secretsPurged) {
    if (r.secretsPurged.deleted > 0) log.success(`deleted ${r.secretsPurged.deleted} SSM secret(s)`);
    for (const f of r.secretsPurged.failed) log.warn(`secret purge: ${f}`);
  }
}

async function runEnvDestroy(env: string, opts: DestroyOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const scope = defaultProjectScope(opts);
  const markers = selectPreviewMarkers(await loadEnvMarkers(aws), env, scope.project, scope.component);

  if (markers.length === 0) {
    const where =
      scope.project !== undefined
        ? ` for project "${scope.project}"${scope.component !== undefined ? ` component "${scope.component}"` : ""}`
        : "";
    throw new CliError(`no environment "${env}"${where}`, {
      hint: "environments are created by `launchpad deploy --env` — see `launchpad destroy --list-envs`",
    });
  }
  if (markers.length > 1) {
    // An explicit --project means "this whole logical project" — tear the env down
    // across all of its components. Anything else is ambiguous: name the owners.
    const oneProject = new Set(markers.map((m) => m.project)).size === 1;
    if (opts.project !== undefined && oneProject) {
      await destroyEnvMarkers(aws, env, markers, opts);
      return;
    }
    const owners = markers.map((m) =>
      m.component !== undefined ? `${m.project} (component ${m.component})` : m.project,
    );
    throw new CliError(`environment "${env}" exists for several footprints: ${owners.join(", ")}`, {
      hint: oneProject
        ? "disambiguate with --component <name>, or pass --project <name> explicitly to destroy the env across ALL components"
        : "disambiguate with --project <name> (and --component <name> when its components share the env)",
    });
  }
  const marker = markers[0] as PreviewMarker;

  if (!isJsonMode()) {
    panel("Destroy environment", [
      color.cyan(describeMarker(marker, Date.now())),
      ...(marker.domains.length > 0 ? [color.dim(`domains: ${marker.domains.join(", ")}`)] : []),
      color.dim("DNS is yours to manage — a wildcard record keeps working; per-env records can be removed at your provider"),
      ...(opts.purgeSecrets
        ? [color.yellow("--purge-secrets: its SSM secrets are deleted (irreversible)")]
        : [color.dim("ECR images and SSM secrets are kept")]),
    ]);
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`destroy environment "${env}" (footprint ${marker.owner})?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }
  if (isJsonMode() && opts.yes !== true) {
    throw new CliError("destroy --env needs --yes in JSON mode", {
      hint: "it destroys an environment — make the go-ahead explicit",
    });
  }

  const spin = isJsonMode() ? null : spinner(`destroying environment ${env}…`).start();
  let report: EnvDestroyReport;
  try {
    report = await destroyEnvFootprint(aws, marker, {
      wait: opts.wait !== false,
      timeoutMs: resolveTimeoutSecondsMs(opts.timeout, DEFAULT_DRAIN_TIMEOUT_SECONDS),
      purgeSecrets: opts.purgeSecrets === true,
    });
    spin?.succeed(`environment ${color.cyan(env)} destroyed`);
  } catch (error) {
    spin?.fail(`could not destroy environment ${env}`);
    throw error;
  }

  if (isJsonMode()) {
    printJson({ destroyed: true, ...report });
    return;
  }
  reportEnvDestroy(report, opts.wait !== false);
}

/**
 * Tear one env down across SEVERAL markers (a project's components sharing the
 * env name) — `destroy --project <name> --env <e>`. Failures keep their marker
 * so a retry can finish the job, mirroring --prune-expired.
 */
async function destroyEnvMarkers(
  aws: AwsEnv,
  env: string,
  markers: PreviewMarker[],
  opts: DestroyOptions,
): Promise<void> {
  if (isJsonMode() && opts.yes !== true) {
    throw new CliError("destroy --env needs --yes in JSON mode", {
      hint: "it destroys environments — make the go-ahead explicit",
    });
  }
  if (!isJsonMode()) {
    panel(
      `Destroy environment ${env} (all components)`,
      markers.map((m) => color.cyan(describeMarker(m, Date.now()))),
    );
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`destroy environment "${env}" for ${markers.length} component footprint(s)?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const reports: EnvDestroyReport[] = [];
  const failed: Array<{ owner: string; error: string }> = [];
  for (const marker of markers) {
    const spin = isJsonMode() ? null : spinner(`destroying ${marker.owner}…`).start();
    try {
      const report = await destroyEnvFootprint(aws, marker, {
        wait: opts.wait !== false,
        timeoutMs: resolveTimeoutSecondsMs(opts.timeout, DEFAULT_DRAIN_TIMEOUT_SECONDS),
        purgeSecrets: opts.purgeSecrets === true,
      });
      reports.push(report);
      spin?.succeed(`destroyed ${color.cyan(marker.owner)}`);
      if (!isJsonMode()) reportEnvDestroy(report, opts.wait !== false);
    } catch (error) {
      spin?.fail(`could not destroy ${marker.owner}`);
      failed.push({ owner: marker.owner, error: (error as Error).message });
      log.warn(`${marker.owner}: ${(error as Error).message} — its marker is kept so a retry can finish`);
    }
  }
  if (isJsonMode()) {
    printJson({ destroyed: failed.length === 0, env, footprints: reports, ...(failed.length > 0 ? { failed } : {}) });
  }
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * `destroy --project <name>` (no --env): registry-driven whole-project teardown,
 * TOML-less — every component's env footprints (marker-driven), then every
 * component's base footprint, then the component index itself. Other projects'
 * services on shared nodes are never touched (planUndeploy scopes by owner).
 */
async function runProjectDestroy(project: string, opts: DestroyOptions): Promise<void> {
  if (isJsonMode() && opts.yes !== true) {
    throw new CliError("destroy --project needs --yes in JSON mode", {
      hint: "it destroys a whole project — make the go-ahead explicit",
    });
  }

  const aws = await prepareAws(opts);
  log.step(
    `cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`,
  );

  const index = await loadProjectIndex(aws, project);
  if (index === null) {
    throw new CliError(`no component registry for project "${project}"`, {
      hint: "the index is written by deploys from this CLI version — run `launchpad destroy` from each component's directory instead (or from the project directory for a single-TOML project)",
    });
  }
  for (const entry of index.components) {
    if (!OWNER_REGEX.test(entry.owner)) {
      throw new CliError(`refusing to destroy "${entry.owner}" — unexpected characters in the footprint name`);
    }
  }

  const envMarkers = (await loadEnvMarkers(aws)).filter((m) => m.project === project);

  if (!isJsonMode()) {
    panel(`Destroy project ${project}`, [
      ...index.components.map(
        (c) => `${color.cyan(c.component)} → footprint ${color.cyan(c.owner)} (${c.services.join(", ")})`,
      ),
      ...(envMarkers.length > 0
        ? envMarkers.map((m) => color.yellow(`env ${describeMarker(m, Date.now())}`))
        : []),
      color.dim("the component registry and each footprint's S3 state are swept"),
      ...(opts.purgeSecrets
        ? [color.yellow("--purge-secrets: their SSM secrets are deleted (irreversible)")]
        : [color.dim("ECR images and SSM secrets are kept")]),
    ]);
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(
      `destroy ALL of project "${project}" (${index.components.length} component(s)${envMarkers.length > 0 ? ` + ${envMarkers.length} env(s)` : ""})?`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const timeoutMs = resolveTimeoutSecondsMs(opts.timeout, DEFAULT_DRAIN_TIMEOUT_SECONDS);
  const destroyed: Array<{ component: string; owner: string; nodes: string[] }> = [];
  const envReports: EnvDestroyReport[] = [];
  const failed: Array<{ owner: string; error: string }> = [];

  // Envs first (marker-driven), so a failed base teardown doesn't orphan them.
  for (const marker of envMarkers) {
    const spin = isJsonMode() ? null : spinner(`destroying env footprint ${marker.owner}…`).start();
    try {
      envReports.push(
        await destroyEnvFootprint(aws, marker, {
          wait: opts.wait !== false,
          timeoutMs,
          purgeSecrets: opts.purgeSecrets === true,
        }),
      );
      spin?.succeed(`destroyed env ${color.cyan(marker.owner)}`);
    } catch (error) {
      spin?.fail(`could not destroy ${marker.owner}`);
      failed.push({ owner: marker.owner, error: (error as Error).message });
    }
  }

  for (const entry of index.components) {
    const spin = isJsonMode() ? null : spinner(`destroying component ${entry.component} (${entry.owner})…`).start();
    try {
      const states = await loadStates(aws);
      const plan = planUndeploy(states, entry.owner, null);
      if (plan.nodes.length > 0) {
        await applyUndeploy(aws, entry.owner, null, plan);
        if (opts.wait !== false) {
          await waitForDrain(aws, plan.nodes.map((n) => n.nodeId), entry.owner, null, timeoutMs);
        }
      }
      if (opts.purgeSecrets === true) {
        await purgeSecrets(aws, entry.owner, plan.removedServices);
      }
      await deletePrefix(aws.s3, aws.bucket, projectStatePrefix(aws.clusterId, entry.owner));
      destroyed.push({ component: entry.component, owner: entry.owner, nodes: plan.nodes.map((n) => n.nodeId) });
      spin?.succeed(`destroyed ${color.cyan(entry.owner)}`);
    } catch (error) {
      spin?.fail(`could not destroy ${entry.owner}`);
      failed.push({ owner: entry.owner, error: (error as Error).message });
    }
  }

  // The index goes last, and only when everything else made it — a partial
  // teardown keeps the registry so a retry still sees the remaining components.
  if (failed.length === 0) {
    await deleteObject(aws.s3, aws.bucket, projectIndexKey(aws.clusterId, project));
  } else {
    log.warn(`project "${project}" was only partially destroyed — the registry is kept so a retry can finish`);
  }

  if (isJsonMode()) {
    printJson({
      destroyed: failed.length === 0,
      project,
      components: destroyed,
      envs: envReports,
      ...(failed.length > 0 ? { failed } : {}),
    });
  } else if (failed.length === 0) {
    log.success(`project ${color.cyan(project)} fully destroyed (${destroyed.length} component(s))`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

async function runPruneExpired(opts: DestroyOptions): Promise<void> {
  if (isJsonMode() && opts.yes !== true) {
    throw new CliError("destroy --prune-expired needs --yes in JSON mode", {
      hint: "it destroys environments — make the go-ahead explicit",
    });
  }

  const aws = await prepareAws(opts);
  const markers = await loadEnvMarkers(aws);
  const plan = planPreviewPrune(markers, Date.now());

  if (plan.expired.length === 0) {
    if (isJsonMode()) {
      printJson({ pruned: [], kept: plan.kept.map((m) => m.owner) });
    } else {
      log.info(
        markers.length === 0
          ? "no environments in this cluster"
          : `nothing expired — ${plan.kept.length} environment(s) still live`,
      );
    }
    return;
  }

  // Without --yes this is a dry run: show what's expired, destroy nothing.
  if (opts.yes !== true) {
    panel(
      "Expired environments (dry run — nothing destroyed)",
      plan.expired.map((m) => color.yellow(describeMarker(m, Date.now()))),
    );
    log.dim("  re-run with --yes to destroy them");
    return;
  }

  if (!isJsonMode()) {
    panel(
      "Expired environments",
      plan.expired.map((m) => color.yellow(describeMarker(m, Date.now()))),
    );
  }

  const reports: EnvDestroyReport[] = [];
  const failed: Array<{ owner: string; error: string }> = [];
  for (const marker of plan.expired) {
    const spin = isJsonMode() ? null : spinner(`destroying expired environment ${marker.env} (${marker.owner})…`).start();
    try {
      const report = await destroyEnvFootprint(aws, marker, {
        wait: opts.wait !== false,
        timeoutMs: resolveTimeoutSecondsMs(opts.timeout, DEFAULT_DRAIN_TIMEOUT_SECONDS),
        purgeSecrets: false,
      });
      reports.push(report);
      spin?.succeed(`destroyed ${color.cyan(marker.owner)}`);
      if (!isJsonMode()) reportEnvDestroy(report, opts.wait !== false);
    } catch (error) {
      spin?.fail(`could not destroy ${marker.owner}`);
      failed.push({ owner: marker.owner, error: (error as Error).message });
      log.warn(`${marker.owner}: ${(error as Error).message} — its marker is kept so the next pass retries`);
    }
  }

  if (isJsonMode()) {
    printJson({
      pruned: reports,
      kept: plan.kept.map((m) => m.owner),
      ...(failed.length > 0 ? { failed } : {}),
    });
  }
  if (failed.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

export async function runDestroy(opts: DestroyOptions): Promise<void> {
  // Mode flags first: --list-envs and --prune-expired are whole-cluster passes
  // that never combine with a targeted destroy.
  if (opts.listEnvs === true && opts.pruneExpired === true) {
    throw new CliError("--list-envs and --prune-expired are different passes — use one");
  }
  if (opts.listEnvs === true) {
    for (const [flag, set] of [
      ["--env", opts.env !== undefined],
      ["--service", opts.service !== undefined],
      ["--purge-secrets", opts.purgeSecrets === true],
    ] as const) {
      if (set) throw new CliError(`--list-envs only lists — it can't combine with ${flag}`);
    }
    await runListEnvs(opts);
    return;
  }
  if (opts.pruneExpired === true) {
    for (const [flag, set] of [
      ["--env", opts.env !== undefined],
      ["--service", opts.service !== undefined],
      ["--project", opts.project !== undefined],
      ["--component", opts.component !== undefined],
      ["--purge-secrets", opts.purgeSecrets === true],
    ] as const) {
      if (set) throw new CliError(`--prune-expired reaps every expired env — it can't combine with ${flag}`);
    }
    await runPruneExpired(opts);
    return;
  }

  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label), e.g. pr-123",
    });
  }
  if (opts.component !== undefined && opts.env === undefined) {
    throw new CliError("--component only scopes an --env teardown (or --list-envs)", {
      hint: "the base footprint comes from the launch-pad.toml in cwd",
    });
  }

  // `--project` without `--env` is the whole-project fan-out: every component's
  // base footprint + env footprints + the component registry, TOML-less.
  if (opts.project !== undefined && opts.env === undefined) {
    if (opts.service !== undefined) {
      throw new CliError("--project destroys whole footprints — it can't combine with --service", {
        hint: "run destroy --service from the owning component's directory",
      });
    }
    await runProjectDestroy(opts.project, opts);
    return;
  }

  // Whole-env teardown is marker-driven (works without launch-pad.toml); a --service
  // partial — env or not — goes through the footprint path (needs the config for the
  // owner project, and never touches the env marker).
  if (opts.env !== undefined && opts.service === undefined) {
    await runEnvDestroy(opts.env, opts);
    return;
  }
  await runFootprintDestroy(opts);
}

export function registerDestroy(program: Command): void {
  const cmd = program
    .command("destroy")
    .description("Remove a deployment — the whole footprint, one service, or a named environment")
    .option("--service <name>", "destroy only this service (default: the whole project footprint)")
    .option("--env <name>", "destroy a named environment created by `deploy --env` (containers + S3 state)")
    .option("--project <name>", "with --env: scope the env teardown; alone: destroy ALL of the project's components")
    .option("--component <name>", "component the env belongs to (when a project's components share the env name)")
    .option("--list-envs", "list this cluster's environments (env, expiry, domains) instead of destroying")
    .option("--prune-expired", "destroy every env past its `deploy --ttl` deadline (dry-run without --yes; cron-able)")
    .option("--purge-secrets", "also delete the removed services' SSM secrets (irreversible)")
    .option("--no-wait", "don't wait for the agent to stop the containers")
    .option("--timeout <seconds>", "how long to wait for the containers to stop", String(DEFAULT_DRAIN_TIMEOUT_SECONDS))
    .option("--yes", "skip the confirmation prompt (required with --json)")
    .addHelpText(
      "after",
      [
        "",
        "Destroy is the inverse of deploy, and the sanctioned way to remove a service the",
        "config lock otherwise freezes: it drops the service(s) from each node's desired.json",
        "(the agent stops the containers) and trims the config baseline so a follow-up `deploy`",
        "of the edited launch-pad.toml passes the lock. With no flags it removes the whole base",
        "footprint and clears the baseline, so the next deploy is a fresh first deploy. Another",
        "project's services on the same nodes are never touched.",
        "",
        "`--env <name>` tears a named environment down end-to-end: remove its footprint and",
        "sweep its S3 state. It is marker-driven, so it works without a launch-pad.toml in",
        "cwd — only environments created by `deploy --env` are eligible. DNS is never touched:",
        "it's yours to manage, and a wildcard record keeps covering the envs that remain.",
        "",
        "ECR images are left in place (immutable + content-addressed; they preserve rollback and",
        "cost almost nothing). SSM secrets are kept unless you pass --purge-secrets.",
        "",
        "Infrastructure teardown is separate: `launchpad node destroy` / `launchpad cluster destroy`.",
        "",
        "Examples:",
        "  $ launchpad destroy --service worker        # remove one service",
        "  $ launchpad destroy                          # remove the whole base footprint",
        "  $ launchpad destroy --env pr-123 --yes       # tear a PR env down (containers + state)",
        "  $ launchpad destroy --list-envs              # what environments exist?",
        "  $ launchpad destroy --prune-expired --yes    # reap every TTL-expired env (cron/CI)",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runDestroy(mergedOpts<DestroyOptions>(command));
    });

  applyGlobalOptions(cmd);
}
