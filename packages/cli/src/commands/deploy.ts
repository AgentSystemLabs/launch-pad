import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  agentIdForNode,
  type CapacityServiceDemand,
  DEFAULT_CLUSTER,
  DEFAULT_RESERVED_CPU,
  DEFAULT_RESERVED_MEMORY,
  type DesiredState,
  edgeConfigKey,
  type LaunchPadConfig,
  type NodeRegistryEntry,
  dockerPlatformForArchitecture,
  PROTOCOL_VERSION,
  type ServiceConfig,
  type ServiceDecl,
  assertConfigLockAllowed,
  backupServicePrefix,
  backupsBucketName,
  baselineFromDeployedFootprints,
  buildDeployEvent,
  CONFIG_LOCK_MUTABLE_HINT,
  type ConfigLockCompareOptions,
  checkCapacity,
  configBaselineKey,
  deployEventKey,
  type DeployKind,
  containerEnvForDeploy,
  databaseImage,
  findCrossComponentServiceConflicts,
  findEnvSecretConflicts,
  desiredKey,
  ecrRepositoryName,
  isDatabaseService,
  remoteBuildContextKey,
  parseEcrImageUri,
  parseConfigBaseline,
  snapshotConfigBaseline,
  emptyDesiredState,
  footprintOwner,
  generateNodeName,
  LABEL_REGEX,
  mergeProjectServices,
  mergeProjectServicesPartial,
  nodeFrontsIngress,
  nodeRegistryKey,
  nodeUsesElasticIp,
  parseDesiredState,
  parseDesiredStateOrEmpty,
  parseNodeRegistryEntry,
  parseNodeStatus,
  buildPreviewMarker,
  parsePreviewMarker,
  parsePreviewTtlMs,
  PREVIEW_TTL_HINT,
  previewMarkerKey,
  type PreviewMarker,
  resolveServiceDomain,
  secretRefsForService,
  secretParameterPath,
  sharesToVcpu,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { getExistingSecretPaths } from "../aws/ssm-secrets";
import { type AwsEnv, prepareAws } from "../aws/context";
import { describeInstancesById, getDefaultVpcId } from "../aws/ec2";
import { ensureRepository, getEcrAuth, imageExists } from "../aws/ecr";
import { ensureBackupsBucket, getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { createOrGetTopic, publishDeployNotification } from "../aws/sns";
import { ensureNodeQueue } from "../aws/sqs";
import { adoptEdgeIfUnset, getClusterConfig, putClusterConfig } from "../cluster/store";
import { loadConfig } from "../config/load";
import { loadProjectIndex, upsertProjectIndex } from "../project/registry";
import { rememberClusterTarget } from "../config/local";
import { buildAndPush, checkDocker, computeImageTag, dockerLoginEcr, ensureBuilder } from "../deploy/build";
import {
  createCodeBuildClient,
  deleteBuildContext,
  ensureRemoteBuildInfra,
  runRemoteBuild,
  uploadBuildContext,
} from "../aws/codebuild";
import { packBuildContext } from "../deploy/context-pack";
import { dockerfileInContext } from "../deploy/remote-build";
import { applyNodeDrift } from "../deploy/drift-apply";
import { type NodeDrift, planNodeDrift } from "../deploy/drift-plan";
import {
  type DeployedPlacementSnapshot,
  loadDeployedFootprints,
  loadDeployedPlacement,
} from "../deploy/deployed-footprint";
import {
  bootstrapCandidateNode,
  type CandidateNode,
  type ClusterServiceInput,
  type Placement,
  planClusterPlacementAutoAdd,
} from "../deploy/placement";
import { buildCandidateNodes, demandsOf } from "../deploy/candidate-nodes";
import {
  buildServiceBuildPaths,
  collectChangedPaths,
  resolveRepoRoot,
  selectChangedServices,
} from "../deploy/changed-services";
import { formatNodeMonthlyCost } from "../cost/estimate";
import { buildDnsChecklist, type DnsTarget, wildcardForPattern } from "../deploy/dns-panel";
import { buildProvisionPlan, type NodeAction, type NodeDemand, planEdgeAction } from "../deploy/provision-plan";
import { waitForConvergence, type WatchResult, type WatchTarget } from "../deploy/watch";
import { CliError } from "../errors";
import { parseTimeoutMs } from "../parse-timeout";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { DEFAULT_AGENT_TYPE } from "../provision/agent-bundle";
import { nodeAmiLookupKey, provisionRoleOf, resolveNodeAmiByRole } from "../provision/golden-ami";
import { provisionNode } from "../provision/provision-node";
import { panel, table } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";
import { readVersion } from "../version";

/**
 * Optimistic-concurrency retries when writing a node's desired.json / edge.json.
 * Each attempt re-reads, re-merges, and conditionally writes; a concurrent deploy
 * to the same node loses the CAS and retries. 5 is enough to absorb a couple of
 * racing deploys without spinning forever.
 */
const MAX_PUBLISH_RETRIES = 5;

/** Default time `deploy` waits for nodes to report convergence (overridable via --timeout). */
const DEFAULT_CONVERGE_TIMEOUT_SECONDS = 180;

/**
 * Name of the dedicated edge node auto-created when the cluster doesn't have one
 * yet. Every cluster runs exactly one Caddy edge on its own node (t4g.nano by
 * default), so every deploy needs at least 2 nodes: the edge + ≥1 app node.
 */
const EDGE_BOOTSTRAP_NODE_ID = "edge-1";

export interface DeployOptions extends GlobalOpts {
  service?: string;
  /** Deploy only services whose build inputs changed since this git ref (monorepo). */
  changed?: string;
  env?: string;
  wait?: boolean;
  timeout?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** commander sets this false for `--no-create` (auto-provisioning is on by default). */
  create?: boolean;
  /** commander sets this false for `--no-repair` (EC2 drift is auto-repaired by default). */
  repair?: boolean;
  /** commander sets this false for `--no-recreate` (a terminated instance is replaced by default). */
  recreate?: boolean;
  /** AMI used for auto-provisioned/recreated nodes. */
  ami?: string;
  /** Skip build/push; re-publish desired state with restartAt to roll containers. */
  restart?: boolean;
  /** Skip build/push; publish an existing immutable ECR tag (rollback / promote). Needs --service. */
  image?: string;
  /** Build on AWS CodeBuild instead of local docker (slim CI runners). */
  remoteBuild?: boolean;
  /** Env TTL (`30m` / `72h` / `7d`) — arms `destroy --prune-expired` teardown. Requires --env. */
  ttl?: string;
  /** Allow new [[service]] blocks in launch-pad.toml (adding services to an existing footprint). */
  allowNewServices?: boolean;
  /** Mask the edge IP in the DNS panel (default on under GitHub Actions / LAUNCHPAD_HIDE_IP). */
  hideIp?: boolean;
  /** Force-show the edge IP even under CI auto-hide. */
  showIp?: boolean;
}

interface BuiltService {
  decl: ServiceDecl;
  repoName: string;
  repoUri: string;
  tag: string;
  image: string;
  contextDir: string;
  dockerfilePath: string;
  /** The env-projected domain (literal when no --env), or undefined for a worker. */
  domain?: string | undefined;
}

/** A built service placed on a node with a specific replica count. */
interface NodeService {
  built: BuiltService;
  replicas: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A stand-in registry entry for a to-be-created node, so a `--dry-run` can run the
 * capacity/placement preview without provisioning anything. */
function synthesizeEntry(aws: AwsEnv, a: Extract<NodeAction, { kind: "create" }>): NodeRegistryEntry {
  return {
    nodeId: a.nodeId,
    clusterId: aws.clusterId,
    instanceId: null,
    instanceType: a.instanceType,
    architecture: a.architecture,
    region: aws.region,
    availabilityZone: null,
    role: a.role,
    privateIp: null,
    totalCpu: a.capacity.totalCpu,
    totalMemory: a.capacity.totalMemory,
    reservedCpu: DEFAULT_RESERVED_CPU,
    reservedMemory: DEFAULT_RESERVED_MEMORY,
    publicIp: null,
    eipAllocationId: null,
    securityGroupId: null,
    iamInstanceProfile: null,
    provisioning: "ec2",
    advertiseIp: null,
    iamUserName: null,
    agentId: agentIdForNode(a.nodeId),
    agentVersion: null,
    agentType: DEFAULT_AGENT_TYPE,
    createdAt: nowIso(),
    createdBy: aws.callerArn,
    state: "provisioning",
  };
}

/** Present / past verb forms for a drift repair, used in spinner labels. */
function repairVerb(d: NodeDrift): { ing: string; ed: string } {
  switch (d.action.kind) {
    case "resume":
      return { ing: "resuming", ed: "resumed" };
    case "sync":
      return { ing: "syncing", ed: "synced" };
    case "recreate":
      return { ing: "recreating", ed: "recreated" };
    default:
      return { ing: "repairing", ed: "repaired" };
  }
}

/** One panel line describing a drift repair. */
function repairLine(entry: NodeRegistryEntry, d: NodeDrift): string {
  const id = color.cyan(entry.nodeId);
  switch (d.action.kind) {
    case "resume":
      return `${color.yellow("▶ resume")} ${id} ${color.dim(d.drift === "stopped" ? "stopped in EC2" : "paused")}`;
    case "sync":
      return `${color.blue("↻ sync")} ${id} ${color.dim("running in EC2 — adopting live state")}`;
    case "recreate":
      return `${color.red("⟳ recreate")} ${id} ${color.dim(
        nodeUsesElasticIp(entry.role)
          ? "instance gone — same id + Elastic IP"
          : "instance gone — same id (VPC-private)",
      )}`;
    default:
      return `${color.red("✗ blocked")} ${id} ${color.dim(d.action.kind === "blocked" ? d.action.reason : "")}`;
  }
}

export function toServiceConfig(
  aws: AwsEnv,
  project: string,
  // Only the resolved decl + image + domain are needed — `rebalance` reuses this with a
  // published image instead of a freshly-built one (no repo/tag/context fields).
  b: { decl: ServiceDecl; image: string; domain?: string | undefined },
  replicas: number,
  resolvedEdge: string | null,
  env: string | undefined,
  restart: boolean,
): ServiceConfig {
  const isWeb = b.domain !== undefined && b.decl.port !== undefined;
  if (isWeb && resolvedEdge === null) {
    // Caddy never co-locates with app containers — a web service must route
    // through the cluster's dedicated edge.
    throw new CliError(`service "${b.decl.name}" serves a domain but resolved no edge node`, {
      hint: "the cluster's dedicated edge is required for web services — re-run deploy to provision it",
    });
  }
  const cfg: ServiceConfig = {
    project,
    service: b.decl.name,
    image: b.image,
    cpu: b.decl.cpu,
    memory: b.decl.memory,
    replicas,
    env: containerEnvForDeploy(b.decl.env, env),
    secretRefs: secretRefsForService(b.decl.secrets, {
      clusterId: aws.clusterId,
      ownerProject: project,
      service: b.decl.name,
    }),
    ingress: isWeb
      ? { domain: b.domain as string, port: b.decl.port as number, edge: resolvedEdge as string }
      : null,
    healthCheck: b.decl.healthCheck
      ? { ...b.decl.healthCheck, port: b.decl.healthCheck.port ?? b.decl.port }
      : null,
    rollout: b.decl.rollout,
    volumes: b.decl.volumes.map((v) => ({ ...v })),
  };
  if (b.decl.cron !== undefined) cfg.cron = b.decl.cron;
  // Managed database: carry the engine/version marker (the agent runs the pinned image
  // instead of building one) and, when a backup is configured, the resolved S3 target.
  if (b.decl.database !== undefined) {
    cfg.database = {
      engine: b.decl.database.engine,
      version: b.decl.database.version,
      databases: b.decl.database.databases,
    };
    if (b.decl.backup !== undefined) {
      cfg.backup = {
        schedule: b.decl.backup.schedule,
        retentionDays: b.decl.backup.retentionDays,
        bucket: backupsBucketName(aws.accountId, aws.region),
        prefix: backupServicePrefix(aws.clusterId, project, b.decl.name),
      };
    }
  }
  if (restart) cfg.restartAt = nowIso();
  return cfg;
}

/** Fail fast when a service declares secrets missing from SSM. */
export async function assertSecretsPresent(aws: AwsEnv, services: ServiceDecl[], ownerProject: string): Promise<void> {
  const missing: string[] = [];
  for (const decl of services) {
    if (decl.secrets.length === 0) continue;
    const paths = decl.secrets.map((key) =>
      secretParameterPath({
        clusterId: aws.clusterId,
        ownerProject,
        service: decl.name,
        key,
      }),
    );
    const found = await getExistingSecretPaths(aws.ssm, paths);
    for (const key of decl.secrets) {
      const path = secretParameterPath({
        clusterId: aws.clusterId,
        ownerProject,
        service: decl.name,
        key,
      });
      if (!found.has(path)) missing.push(`${decl.name}/${key}`);
    }
  }
  if (missing.length === 0) return;
  throw new CliError(`missing SSM secrets: ${missing.join(", ")}`, {
    hint: "set them with `launchpad secret set <KEY> --service <name>`",
  });
}

/** Load the image currently published for each service (for deploy --restart). */
async function loadRestartImages(
  aws: AwsEnv,
  services: ServiceDecl[],
  ownerProject: string,
  nodeIds: string[],
): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  for (const id of nodeIds) {
    const obj = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, id));
    if (!obj) continue;
    const state = parseDesiredState(obj.raw);
    for (const s of state.services) {
      if (s.project !== ownerProject) continue;
      if (!images.has(s.service)) images.set(s.service, s.image);
    }
  }
  const missing = services.filter((s) => !images.has(s.name)).map((s) => s.name);
  if (missing.length > 0) {
    throw new CliError(`no published image for: ${missing.join(", ")}`, {
      hint: "run a full deploy first, or check that the service is scheduled on a node",
    });
  }
  return images;
}

/**
 * Validate a `--image <uri>` override for a single service and return it as the same
 * {service → image} map the restart path produces. The URI must be a tagged image in the
 * service's OWN ECR repo (`<project>/<service>`) and the tag must already exist — so a
 * rollback/promote can only ever re-point a service at one of its own immutable builds,
 * never an arbitrary or unbuilt image.
 */
export async function loadOverrideImage(
  aws: AwsEnv,
  project: string,
  service: ServiceDecl,
  uri: string,
): Promise<Map<string, string>> {
  const parsed = parseEcrImageUri(uri);
  if (!parsed) {
    throw new CliError(`invalid --image "${uri}"`, {
      hint: "pass a tagged ECR image URI, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/<project>/<service>:<tag>",
    });
  }
  // The registry must be THIS account + region's ECR — otherwise the URI could pass the
  // existence check (which queries our own account by repo name) yet publish an image the
  // node can't pull (cross-account/region), silently stalling convergence.
  const expectedRegistry = `${aws.accountId}.dkr.ecr.${aws.region}.amazonaws.com`;
  if (parsed.registry !== expectedRegistry) {
    throw new CliError(`--image must be in your account's ECR registry`, {
      hint: `expected "${expectedRegistry}", got "${parsed.registry}"`,
    });
  }
  const expectedRepo = ecrRepositoryName(project, service.name);
  if (parsed.repository !== expectedRepo) {
    throw new CliError(`--image is not in service "${service.name}"'s repository`, {
      hint: `expected repo "${expectedRepo}", got "${parsed.repository}" — you can only redeploy one of this service's own builds`,
    });
  }
  if (!(await imageExists(aws.ecr, parsed.repository, parsed.tag))) {
    throw new CliError(`image tag "${parsed.tag}" not found in ECR repo "${parsed.repository}"`, {
      hint: "list available tags in the AWS console, or run a normal `deploy` to build a fresh one",
    });
  }
  return new Map([[service.name, uri]]);
}

async function loadRunningContainerIds(
  aws: AwsEnv,
  nodeId: string,
  project: string,
  service: string,
): Promise<string[]> {
  const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
  if (!obj) return [];
  const status = parseNodeStatus(obj.raw);
  const svc = status.services.find((s) => s.project === project && s.service === service);
  return (svc?.replicas ?? [])
    .filter((r) => r.state === "running" && r.containerId)
    .map((r) => r.containerId as string)
    .sort();
}

/**
 * cpu/memory demands (multiplied by replicas) of an existing service set, plus the
 * transient surge a rolling update of that service adds: `min(maxSurge, replicas)`
 * extra replicas run simultaneously during the roll (the agent caps total at
 * `replicas + maxSurge` but never exceeds `replicas` *new* ones at once).
 */
/**
 * Full demands a node carries after this deploy. Always counts other projects'
 * services plus this deploy's placements. For a PARTIAL deploy it ALSO counts the
 * project's own services already on the node that this run isn't republishing — a
 * partial deploy upserts (preserves) them, so they keep consuming capacity and the
 * pre-flight must see them (a full deploy replaces the footprint, so they're absent).
 */
function capacityDemands(
  project: string,
  state: DesiredState,
  placed: NodeService[],
  partial: boolean,
): CapacityServiceDemand[] {
  const others = demandsOf(state.services.filter((s) => s.project !== project));
  const placedNames = new Set(placed.map((p) => p.built.decl.name));
  const keptSiblings = partial
    ? demandsOf(state.services.filter((s) => s.project === project && !placedNames.has(s.service)))
    : [];
  const incoming = placed.map((p) => {
    const surge = Math.min(p.built.decl.rollout.maxSurge, p.replicas);
    return {
      project,
      service: p.built.decl.name,
      cpu: p.built.decl.cpu * p.replicas,
      memory: p.built.decl.memory * p.replicas,
      surgeCpu: p.built.decl.cpu * surge,
      surgeMemory: p.built.decl.memory * surge,
    };
  });
  return [...others, ...keptSiblings, ...incoming];
}

function assertCapacity(nodeId: string, node: NodeRegistryEntry, merged: CapacityServiceDemand[]): void {
  const result = checkCapacity({
    totalCpu: node.totalCpu,
    totalMemory: node.totalMemory,
    reservedCpu: node.reservedCpu,
    reservedMemory: node.reservedMemory,
    services: merged,
  });
  if (result.ok) return;

  const rows: Array<[string, string]> = merged.map((s) => [
    `${s.project}/${s.service}`,
    `${sharesToVcpu(s.cpu)} vCPU · ${s.memory} MB`,
  ]);
  if (result.surgeCpu > 0 || result.surgeMemory > 0) {
    rows.push(["── rollout surge", `+${sharesToVcpu(result.surgeCpu)} vCPU · +${result.surgeMemory} MB`]);
  }
  rows.push(["── peak total", `${sharesToVcpu(result.usedCpu)} vCPU · ${result.usedMemory} MB`]);
  rows.push(["── allocatable", `${sharesToVcpu(result.allocatableCpu)} vCPU · ${result.allocatableMemory} MB`]);

  const over: string[] = [];
  if (result.cpuOverBy > 0) over.push(`${sharesToVcpu(result.cpuOverBy)} vCPU`);
  if (result.memoryOverBy > 0) over.push(`${result.memoryOverBy} MB`);

  throw new CliError(
    `node "${nodeId}" does not have enough capacity (over by ${over.join(" and ")})\n` +
      table(rows)
        .map((l) => `  ${l}`)
        .join("\n"),
    { hint: "reduce cpu/memory/replicas, move a service to another node, or use a larger instance type" },
  );
}

/** A service's resolved placement: where its replicas land and the edge fronting it. */
interface Resolved {
  placements: Placement[];
  /** Every node considered (the full eligible app pool) — all of them are
   * drift-checked/repaired even when a node receives zero replicas. */
  pool: string[];
  /** The edge fronting this service's domain (the cluster edge), or null for a worker. */
  edge: string | null;
  domain?: string | undefined;
}

interface PlacementPlanEntry {
  service: string;
  placements: Placement[];
  edge: string | null;
}

/** The service-major placement map shown on every deploy (human + --json). */
function buildPlacementPlan(
  services: ServiceDecl[],
  resolved: Map<string, Resolved>,
): PlacementPlanEntry[] {
  return services.map((s) => {
    const r = resolved.get(s.name) as Resolved;
    return {
      service: s.name,
      placements: r.placements,
      edge: r.edge,
    };
  });
}

function printPlacementPlan(plan: PlacementPlanEntry[]): void {
  if (isJsonMode()) return;
  panel(
    "Placement",
    plan.map((e) => {
      const where = e.placements.map((p) => `${p.nodeId}${color.dim(`×${p.replicas}`)}`).join(", ");
      const via = e.edge ? ` via ${color.cyan(e.edge)}` : "";
      return `${color.cyan(e.service)} → ${where}${via}`;
    }),
  );
}

function printCapacitySummary(nodeId: string, node: NodeRegistryEntry, placed: NodeService[]): void {
  if (isJsonMode()) return;
  const usedCpu = placed.reduce((s, p) => s + p.built.decl.cpu * p.replicas, 0);
  const usedMemory = placed.reduce((s, p) => s + p.built.decl.memory * p.replicas, 0);
  panel(`Node ${nodeId}`, [
    ...placed.map(
      (p) =>
        `${color.cyan(p.built.decl.name)} ${color.dim(`×${p.replicas}`)}  ` +
        `${sharesToVcpu(p.built.decl.cpu * p.replicas)} vCPU · ${p.built.decl.memory * p.replicas} MB`,
    ),
    color.dim(
      `used ${sharesToVcpu(usedCpu)}/${sharesToVcpu(node.totalCpu - node.reservedCpu)} vCPU · ` +
        `${usedMemory}/${node.totalMemory - node.reservedMemory} MB`,
    ),
  ]);
}

/**
 * Read → merge → capacity-check → conditional write, retrying on concurrent writes.
 *
 * `partial` selects the merge: a FULL deploy (default) replaces the project's whole
 * footprint on the node, so a service dropped from the config is removed; a PARTIAL
 * deploy (`--service` / `--changed`) UPSERTS only `incoming`, preserving the project's
 * co-located siblings the subset deploy didn't republish (mergeProjectServicesPartial)
 * — otherwise deploying one service would tear down the others on a shared node.
 */
export async function publishDesired(
  aws: AwsEnv,
  nodeId: string,
  node: NodeRegistryEntry,
  project: string,
  incoming: ServiceConfig[],
  partial = false,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
    const state = existing
      ? parseDesiredStateOrEmpty(nodeId, existing.raw, nowIso())
      : emptyDesiredState(nodeId, nowIso());
    const merged = partial
      ? mergeProjectServicesPartial(state.services, project, incoming)
      : mergeProjectServices(state.services, project, incoming);
    assertCapacity(nodeId, node, demandsOf(merged));

    const next: DesiredState = { version: PROTOCOL_VERSION, nodeId, updatedAt: nowIso(), services: merged };
    try {
      await putJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId), next, {
        ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }),
      });
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  throw new CliError(`could not publish desired state for node "${nodeId}"`, {
    hint: "another deploy may be racing this node — try again",
  });
}

/** Advisory edge.json: union this project's fronted domains into the edge's list. */
export async function publishEdgeConfig(aws: AwsEnv, edgeId: string, domains: string[]): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, edgeConfigKey(aws.clusterId, edgeId));
    const current = (existing?.raw as { domains?: string[] } | undefined)?.domains ?? [];
    const union = [...new Set([...current, ...domains])].sort();
    try {
      await putJson(
        aws.s3,
        aws.bucket,
        edgeConfigKey(aws.clusterId, edgeId),
        { nodeId: edgeId, domains: union, updatedAt: nowIso() },
        { ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }) },
      );
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
}

function configLockError(error: unknown): never {
  throw new CliError((error as Error).message, {
    hint: `${CONFIG_LOCK_MUTABLE_HINT} — revert the other edits (or use \`launchpad scale\` / \`launchpad config set\` for the allowed ones)`,
  });
}

/** A prior deploy's locked config, with where it was loaded from (for the log line). */
interface LockBaseline {
  baseline: ReturnType<typeof snapshotConfigBaseline>;
  /** "the S3 config baseline" (authoritative) | "published desired state" (reconstructed). */
  source: string;
  /** True when reconstructed from desired.json (which omits dockerfile/context/domainPattern). */
  fromDesired: boolean;
}

/**
 * Load the locked baseline for a footprint, or null when it has never deployed.
 *
 * Two sources, in order: the frozen `config-baseline.json` (authoritative, written
 * on every successful deploy) and — when that file is absent (pre-feature or failed
 * deploys) — a baseline reconstructed from each node's `desired.json`. If deployed
 * state clearly exists but can't be read (403, unparseable), this FAILS LOUDLY
 * rather than treating it as a first deploy and silently skipping the lock.
 */
async function loadLockBaseline(
  aws: AwsEnv,
  ownerProject: string,
  /** Logical identity from the deploying TOML — what a reconstructed baseline records. */
  identity: { project: string; component?: string | undefined },
): Promise<LockBaseline | null> {
  let baselineFile;
  try {
    baselineFile = await getJson(aws.s3, aws.bucket, configBaselineKey(aws.clusterId, ownerProject));
  } catch {
    throw new CliError(`could not read the config baseline for "${ownerProject}" from S3`, {
      hint: "fix AWS credentials / bucket access and retry — deploy won't proceed while the config lock can't be verified",
    });
  }

  if (baselineFile) {
    try {
      return { baseline: parseConfigBaseline(baselineFile.raw), source: "the S3 config baseline", fromDesired: false };
    } catch {
      log.warn(`config lock: stored baseline for "${ownerProject}" is unreadable — falling back to published desired state`);
    }
  }

  let footprints;
  try {
    footprints = await loadDeployedFootprints(aws.s3, aws.bucket, aws.clusterId, ownerProject);
  } catch {
    throw new CliError(`could not read published desired state to verify the config lock for "${ownerProject}"`, {
      hint: "fix AWS credentials / bucket access and retry — deploy won't proceed while the config lock can't be verified",
    });
  }
  if (footprints.length > 0) {
    return {
      baseline: baselineFromDeployedFootprints(identity, footprints, nowIso()),
      source: "published desired state",
      fromDesired: true,
    };
  }

  // A baseline file existed but couldn't be parsed AND no desired state remains to
  // reconstruct from: deploy clearly happened, but the lock can't be verified — fail
  // loud rather than silently treat it as a first deploy and allow any change.
  if (baselineFile) {
    throw new CliError(`the config baseline for "${ownerProject}" is corrupt and no published state remains to verify against`, {
      hint: "this footprint has deployed before; restore a valid baseline or redeploy the original launch-pad.toml unchanged",
    });
  }
  return null;
}

/** What the config lock decided for this deploy's launch-pad.toml. */
export type ConfigLockOutcome = { kind: "first-deploy" } | { kind: "clean" };

/**
 * Verify the launch-pad.toml diff against the locked baseline. Runs BEFORE any
 * build / ECR push / S3 write. Identity changes (anything but cpu, memory,
 * replicas, env, secrets, and domainPattern — see CONFIG_LOCK_MUTABLE_HINT) throw
 * immediately, with no bypass flag.
 */
export async function resolveConfigLockOutcome(
  aws: AwsEnv,
  config: LaunchPadConfig,
  ownerProject: string,
  lockOpts?: Pick<ConfigLockCompareOptions, "allowNewServices">,
): Promise<ConfigLockOutcome> {
  const deployed = await loadLockBaseline(aws, ownerProject, {
    project: config.project,
    component: config.component,
  });
  if (!deployed) {
    log.dim(`config lock: no prior deploy for ${color.cyan(ownerProject)} — recording a baseline after this deploy`);
    return { kind: "first-deploy" };
  }
  log.step(`config lock: comparing launch-pad.toml against ${deployed.source}`);

  const current = snapshotConfigBaseline(config, nowIso());
  try {
    assertConfigLockAllowed(deployed.baseline, current, {
      baselineFromDesired: deployed.fromDesired,
      allowNewServices: lockOpts?.allowNewServices,
    });
  } catch (error) {
    configLockError(error);
  }
  return { kind: "clean" };
}

/**
 * Strict config-lock gate for commands that publish without a build (rebalance,
 * and any caller that requires the toml to match the deployed footprint exactly).
 */
export async function enforceConfigLock(
  aws: AwsEnv,
  config: LaunchPadConfig,
  ownerProject: string,
): Promise<void> {
  await resolveConfigLockOutcome(aws, config, ownerProject);
}

async function writeConfigBaseline(
  aws: AwsEnv,
  config: LaunchPadConfig,
  ownerProject: string,
): Promise<void> {
  await putJson(
    aws.s3,
    aws.bucket,
    configBaselineKey(aws.clusterId, ownerProject),
    snapshotConfigBaseline(config, nowIso()),
  );
}

interface DeployEventInput {
  ownerProject: string;
  env: string | undefined;
  kind: DeployKind;
  services: Array<{ service: string; image: string; replicas: number }>;
  /** Convergence result, or null for a --no-wait deploy. */
  converged: boolean | null;
}

/**
 * Append an append-only deploy-history event (who / when / images / converged). Best-effort:
 * history is advisory (audit + `rollback` hint, never read by reconcile), so a failed write
 * never fails an otherwise-successful deploy.
 */
async function recordDeployEvent(aws: AwsEnv, input: DeployEventInput): Promise<void> {
  const at = nowIso();
  const event = buildDeployEvent({
    at,
    by: aws.callerArn,
    cluster: aws.clusterId,
    project: input.ownerProject,
    env: input.env,
    kind: input.kind,
    services: input.services,
    converged: input.converged,
  });
  try {
    await putJson(
      aws.s3,
      aws.bucket,
      deployEventKey(aws.clusterId, input.ownerProject, at, randomBytes(4).toString("hex")),
      event,
    );
  } catch (error) {
    log.dim(`  could not record deploy history: ${(error as Error).message}`);
  }
}

/**
 * Preview-environment bookkeeping for an `--env` deploy: write or refresh the
 * footprint's `preview.json` marker — the registry `destroy --list-envs` /
 * `destroy --env` / `destroy --prune-expired` operate on. DNS is user-managed (a
 * wildcard at the edge covers every env subdomain), so the marker records domains for
 * display only. Best-effort like deploy history: a failure warns, never fails an
 * otherwise-successful deploy.
 */
async function recordPreviewState(
  aws: AwsEnv,
  config: LaunchPadConfig,
  env: string,
  ttlMs: number | null,
): Promise<void> {
  const owner = footprintOwner(config, env);
  try {
    const key = previewMarkerKey(aws.clusterId, owner);
    let prior: PreviewMarker | null = null;
    try {
      const obj = await getJson(aws.s3, aws.bucket, key);
      if (obj) prior = parsePreviewMarker(obj.raw);
    } catch {
      // Unreadable/older marker — rebuild it fresh below.
    }

    // Config-wide projected domains (not just this deploy's subset) so the marker
    // reflects the whole env even on a partial (--service / --changed) deploy.
    const domains = config.service
      .map((s) =>
        resolveServiceDomain(
          { domain: s.domain, domainPattern: s.domainPattern ?? config.domainPattern, service: s.name },
          env,
        ),
      )
      .filter((d): d is string => d !== undefined);

    const marker = buildPreviewMarker({
      project: config.project,
      component: config.component,
      env,
      now: nowIso(),
      ttlMs,
      domains,
      prior,
    });
    await putJson(aws.s3, aws.bucket, key, marker);
    if (marker.expiresAt !== null) {
      log.step(
        `env ${color.cyan(env)} expires ${color.cyan(marker.expiresAt)} ${color.dim("— `launchpad destroy --prune-expired` reaps it")}`,
      );
    }
  } catch (error) {
    log.warn(`could not record env marker for "${owner}": ${(error as Error).message}`);
  }
}

/**
 * Build + push every not-yet-built service on AWS CodeBuild (`deploy --remote-build`):
 * ensure the cluster's build project, then per service pack the context tarball,
 * upload it under the footprint's `builds/` prefix, run one build, and clean the
 * tarball up. The resulting images use the same target platform as the local buildx
 * path (immutable tag, architecture-matched) — everything after the build is identical.
 */
async function runRemoteBuilds(
  aws: AwsEnv,
  built: BuiltService[],
  ownerProject: string,
  platformByService: Map<string, string>,
): Promise<void> {
  const pending: BuiltService[] = [];
  for (const b of built) {
    // A managed database runs a pinned engine image — nothing to build or push.
    if (isDatabaseService(b.decl)) continue;
    if (await imageExists(aws.ecr, b.repoName, b.tag)) {
      log.step(`${color.cyan(b.decl.name)}: image ${color.dim(b.tag)} already in ECR — skipping build`);
      continue;
    }
    pending.push(b);
  }
  if (pending.length === 0) return;

  const codebuild = createCodeBuildClient(aws.region);
  const infra = spinner("ensuring the cluster's CodeBuild project…").start();
  let projectName: string;
  try {
    ({ projectName } = await ensureRemoteBuildInfra(codebuild, aws.iam, {
      clusterId: aws.clusterId,
      bucket: aws.bucket,
      region: aws.region,
      accountId: aws.accountId,
    }));
    infra.succeed(`CodeBuild project ${color.cyan(projectName)} ready`);
  } catch (error) {
    infra.fail("could not set up the CodeBuild project");
    throw error;
  }

  const ecrRegistry = `${aws.accountId}.dkr.ecr.${aws.region}.amazonaws.com`;
  for (const b of pending) {
    // Validated before any AWS call in runDeploy, so this can't be null here.
    const dockerfile = dockerfileInContext(b.contextDir, b.dockerfilePath) as string;
    const contextKey = remoteBuildContextKey(aws.clusterId, ownerProject, b.decl.name, b.tag);
    const spin = spinner(`packing build context for ${b.decl.name}…`).start();
    try {
      const { file, bytes } = await packBuildContext(b.contextDir, { alwaysInclude: [dockerfile] });
      try {
        spin.text = `uploading ${b.decl.name} context (${(bytes / 1024 / 1024).toFixed(1)} MB)…`;
        await uploadBuildContext(aws.s3, aws.bucket, contextKey, file, bytes);
      } finally {
        rmSync(file, { force: true });
      }
      spin.text = `building ${b.decl.name} → ${b.tag} on CodeBuild…`;
      await runRemoteBuild(codebuild, aws.logs, {
        projectName,
        contextBucket: aws.bucket,
        contextKey,
        imageUri: b.image,
        dockerfile,
        platform: platformByService.get(b.decl.name) ?? "linux/arm64",
        ecrRegistry,
        onProgress: (text) => {
          spin.text = `${b.decl.name} → ${b.tag}: ${text}`;
        },
      });
      spin.succeed(`built + pushed ${color.cyan(b.decl.name)} → ${color.dim(b.tag)} ${color.dim("(CodeBuild)")}`);
    } catch (error) {
      if (spin.isSpinning) spin.fail(`remote build failed for ${b.decl.name}`);
      throw error;
    } finally {
      await deleteBuildContext(aws.s3, aws.bucket, contextKey);
    }
  }
}

export async function runDeploy(opts: DeployOptions): Promise<void> {
  const { config, dir } = loadConfig();

  const env = opts.env;
  if (env !== undefined && !LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label), e.g. staging, dev, pr-42",
    });
  }
  // The footprint owner: base project, or `<project>-<env>` so an env coexists with prod.
  const ownerProject = footprintOwner(config, env);

  // `--ttl` arms `destroy --prune-expired` teardown for this env — meaningless without one.
  let previewTtlMs: number | null = null;
  if (opts.ttl !== undefined) {
    if (env === undefined) {
      throw new CliError("--ttl requires --env (a TTL only applies to a named environment)", {
        hint: "e.g. launchpad deploy --env pr-123 --ttl 72h",
      });
    }
    previewTtlMs = parsePreviewTtlMs(opts.ttl);
    if (previewTtlMs === null) {
      throw new CliError(`invalid --ttl "${opts.ttl}"`, { hint: PREVIEW_TTL_HINT });
    }
  }

  let services = config.service;
  if (opts.service !== undefined && opts.changed !== undefined) {
    throw new CliError("--service and --changed select services two different ways — use one", {
      hint: "--service <name> picks one explicitly; --changed <ref> derives the set from a git diff",
    });
  }
  if (opts.service) {
    services = services.filter((s) => s.name === opts.service);
    if (services.length === 0) {
      throw new CliError(`no service named "${opts.service}" in launch-pad.toml`, {
        hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
      });
    }
  }
  // `--changed <ref>`: deploy only services whose build inputs (context dir / Dockerfile)
  // differ from <ref> — first-class "deploy changed services only" for monorepos / CI.
  if (opts.changed !== undefined) {
    if (opts.image !== undefined || opts.restart === true) {
      const other = opts.image !== undefined ? "--image" : "--restart";
      throw new CliError(`--changed cannot be combined with ${other}`, {
        hint: `--changed rebuilds the services whose code changed; ${other} re-publishes an existing image of one service`,
      });
    }
    const repoRoot = await resolveRepoRoot(dir);
    let changedPaths: Set<string>;
    try {
      changedPaths = await collectChangedPaths(repoRoot, opts.changed);
    } catch (error) {
      throw new CliError((error as Error).message);
    }
    // A managed database has no build inputs (it runs a pinned engine image), so it can
    // never be "changed" by a code diff — exclude it from the changed-selection candidates.
    const buildableServices = config.service.filter((s) => !isDatabaseService(s));
    const changedNames = new Set(
      selectChangedServices(buildServiceBuildPaths(buildableServices, dir, repoRoot), [...changedPaths]),
    );
    services = services.filter((s) => changedNames.has(s.name));
    if (services.length === 0) {
      // No service's build inputs changed since <ref> — a clean no-op (e.g. a docs-only
      // commit in CI). Exit 0 BEFORE touching AWS so the deploy job stays green.
      if (isJsonMode()) {
        printJson({ changed: opts.changed, services: [], published: false, reason: "no changed services" });
      } else {
        log.info(`no services changed since ${color.cyan(opts.changed)} — nothing to deploy`);
      }
      return;
    }
    if (!isJsonMode()) {
      log.step(
        `changed since ${color.cyan(opts.changed)}: ${services.map((s) => color.cyan(s.name)).join(", ")}`,
      );
    }
  }
  // A partial (subset) deploy publishes fewer than the whole footprint, so it must
  // UPSERT into each node's desired.json (preserving same-node siblings) and skip the
  // vacated-node cleanup (which can't see the project's full intended placement).
  const partialDeploy = opts.service !== undefined || opts.changed !== undefined;

  for (const s of services) {
    const conflicts = findEnvSecretConflicts(s.env, s.secrets);
    if (conflicts.length > 0) {
      throw new CliError(`service "${s.name}" declares the same key in env and secrets: ${conflicts.join(", ")}`, {
        hint: "move sensitive values to secrets — keep only non-secret config in env",
      });
    }
  }

  // `--image <uri>` and `--restart` both skip the build and re-publish an existing image;
  // `--image` re-points one service at a specific immutable tag (rollback / promote).
  if (opts.image !== undefined) {
    if (opts.restart === true) {
      throw new CliError("--image cannot be combined with --restart", {
        hint: "--restart reuses the published image; --image picks a specific one — use one or the other",
      });
    }
    if (services.length !== 1) {
      throw new CliError("--image requires exactly one service", {
        hint:
          config.service.length > 1
            ? `pass --service <name> (available: ${config.service.map((s) => s.name).join(", ")})`
            : "the project must have a single service to target with --image",
      });
    }
    // Fast-fail on a malformed URI before any AWS call (loadOverrideImage re-validates the
    // repo + tag existence authoritatively once we have an ECR client).
    if (!parseEcrImageUri(opts.image)) {
      throw new CliError(`invalid --image "${opts.image}"`, {
        hint: "pass a tagged ECR image URI, e.g. <acct>.dkr.ecr.<region>.amazonaws.com/<project>/<service>:<tag>",
      });
    }
  }
  // True when this deploy reuses an existing image instead of building: skip the build,
  // skip cluster re-planning, and pin each service to where it is already published.
  const reuseExistingImages = opts.restart === true || opts.image !== undefined;

  if (opts.remoteBuild === true) {
    if (reuseExistingImages) {
      const other = opts.image !== undefined ? "--image" : "--restart";
      throw new CliError(`--remote-build cannot be combined with ${other}`, {
        hint: `${other} skips the build entirely, so there is nothing to build remotely`,
      });
    }
    // A remote build ships ONLY the context tarball, so the dockerfile must live
    // inside it. Fail fast — before any AWS call or node provisioning. A managed
    // database has no Dockerfile (it runs a pinned engine image), so skip it.
    for (const s of services) {
      if (isDatabaseService(s)) continue;
      if (dockerfileInContext(resolve(dir, s.context), resolve(dir, s.dockerfile)) === null) {
        throw new CliError(
          `service "${s.name}": dockerfile "${s.dockerfile}" is outside its build context "${s.context}"`,
          { hint: "a remote build uploads only the context directory — move the Dockerfile inside it or widen `context`" },
        );
      }
    }
  }

  const aws = await prepareAws(opts, { ensureBucket: true });
  log.step(`cluster ${color.cyan(aws.clusterId)} · account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`);
  log.step(`state bucket ${color.cyan(aws.bucket)}`);
  // Record the cluster's AWS target locally so the `cluster` commands can find a
  // cluster created implicitly via `--cluster` (S3 stays authoritative for existence).
  if (!opts.dryRun) {
    rememberClusterTarget(aws.clusterId, { region: aws.region, profile: opts.profile });
  }
  if (env !== undefined) {
    log.step(`environment ${color.cyan(env)} · footprint ${color.cyan(ownerProject)}`);
  }
  if (opts.restart === true) {
    log.step(`restart mode ${color.dim("(no build — rolling containers to pick up config/secrets)")}`);
  }
  if (opts.image !== undefined) {
    log.step(`image override ${color.cyan(opts.image)} ${color.dim("(no build — redeploying an existing tag)")}`);
  }
  if (opts.remoteBuild === true) {
    log.step(`remote build mode ${color.dim("(images build on AWS CodeBuild — no local docker needed)")}`);
  }

  const lockOutcome = await resolveConfigLockOutcome(aws, config, ownerProject, {
    allowNewServices: opts.allowNewServices === true,
  });
  void lockOutcome;

  // Cross-component service-name uniqueness, BEFORE any build. A project's
  // components share one ECR namespace (`<project>/<service>`), so a duplicate
  // service name in a sibling component would silently share its image repo.
  // Checked against the FULL config (not a --service subset) so siblings the
  // partial deploy doesn't republish are still covered.
  {
    const index = await loadProjectIndex(aws, config.project);
    const conflicts = findCrossComponentServiceConflicts(
      index,
      config.component,
      config.service.map((s) => s.name),
    );
    if (conflicts.length > 0) {
      const lines = conflicts.map(
        (c) => `"${c.service}" is already deployed by component "${c.component}"`,
      );
      throw new CliError(
        `service name conflict in project "${config.project}": ${lines.join("; ")}`,
        {
          hint: "service names must be unique across a project's components (they share one ECR repo namespace) — rename the service, or destroy the old footprint first if this is a migration",
        },
      );
    }
  }

  // Resolve the cluster's app pool + its dedicated edge. Every deploy goes through
  // the scheduler, so the candidate snapshot is always built.
  const clusterCfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);

  // Create/get SNS topic for deploy notifications (graceful failure if SNS unavailable).
  let snsTopicArn: string | null = clusterCfg?.snsTopicArn ?? null;
  if (!opts.dryRun && snsTopicArn === null) {
    try {
      snsTopicArn = await createOrGetTopic(aws.sns, aws.clusterId, aws.region, aws.accountId);
      // Persist topic ARN to cluster config for future deploys.
      if (clusterCfg) {
        await putClusterConfig(aws, { ...clusterCfg, snsTopicArn });
      }
      if (!isJsonMode()) {
        log.info(`deploy notifications enabled (SNS topic: ${snsTopicArn})`);
      }
    } catch (error) {
      if (!isJsonMode()) {
        log.warn(`failed to create SNS topic — deploy notifications disabled (agents will poll): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Auto-add app nodes on capacity pressure is on by default (off for --restart/
  // --image, which re-roll a published placement, and --no-create).
  const autoAddEnabled = !reuseExistingImages && opts.create !== false;
  // Each node's committed demand is read for bin-packing (and auto-add's overflow
  // check so it doesn't add a node a sibling project already fills).
  let { nodes, clusterAppNodeIds, candidateNodes } = await buildCandidateNodes(aws, ownerProject, {
    needsCapacitySnapshot: !reuseExistingImages,
  });

  // The cluster's dedicated edge: cluster.json's defaultEdge, else the registry's
  // single edge-role node, else a fresh `edge-1` auto-provisioned below (t4g.nano).
  // Caddy never co-locates with app containers, so this node is ALWAYS separate
  // from the app pool — a deploy needs at least 2 nodes (edge + app).
  let edgeNodeId = clusterCfg?.defaultEdge ?? null;
  if (edgeNodeId === null) {
    const edgeRoleNodes = [...nodes.values()].filter((n) => nodeFrontsIngress(n.role)).map((n) => n.nodeId);
    if (edgeRoleNodes.length > 1) {
      throw new CliError(
        `cluster "${aws.clusterId}" has ${edgeRoleNodes.length} edge nodes (${edgeRoleNodes.join(", ")}) and no default`,
        { hint: `pick one: launchpad cluster set-edge ${aws.clusterId} <node-id>` },
      );
    }
    edgeNodeId = edgeRoleNodes[0] ?? EDGE_BOOTSTRAP_NODE_ID;
    if (edgeRoleNodes.length === 0 && !isJsonMode()) {
      log.info(
        `cluster "${aws.clusterId}" has no edge node yet — bootstrapping ${color.cyan(EDGE_BOOTSTRAP_NODE_ID)} ` +
          `to route web traffic ${color.dim("(dedicated Caddy node)")}.`,
      );
    }
  }

  // Empty-pool bootstrap: a fresh cluster has no app nodes to place onto. Unless
  // --no-create / --restart / --image, synthesize a single placement target so the
  // planner can place onto it — `deploy` then auto-provisions the real node (sized
  // to fit). --restart/--image have nothing published to re-roll, and --no-create
  // opts out of provisioning, so both fall through to the error below.
  if (clusterAppNodeIds.length === 0 && !reuseExistingImages && opts.create !== false) {
    // The first app node gets a generated `<noun>-<verb>-<adverb>` name, like the
    // capacity auto-add — nodes are cattle, nobody should have to name them.
    const seed = bootstrapCandidateNode(generateNodeName([...nodes.keys(), edgeNodeId]));
    candidateNodes.push(seed);
    clusterAppNodeIds.push(seed.nodeId);
    if (!isJsonMode()) {
      log.info(
        `cluster "${aws.clusterId}" has no app nodes yet — bootstrapping its first node ` +
          `"${seed.nodeId}" to place services on.`,
      );
    }
  }
  if (clusterAppNodeIds.length === 0) {
    throw new CliError(`cluster "${aws.clusterId}" has no app nodes to place services on`, {
      hint: reuseExistingImages
        ? "run a full deploy first to place the service, then --restart/--image can re-roll it"
        : `create one: launchpad node create --cluster ${aws.clusterId} --role app --edge ${edgeNodeId} (or drop --no-create to auto-provision it)`,
    });
  }
  // Where this footprint is published today — drives --restart pinning, sticky
  // volume placement, and the post-publish cleanup of vacated nodes.
  const priorPlacement: DeployedPlacementSnapshot | null = await loadDeployedPlacement(
    aws.s3,
    aws.bucket,
    aws.clusterId,
    ownerProject,
  );

  /** The node a service currently occupies (for sticky volume placement). */
  const publishedNodeOf = (serviceName: string): string | null => {
    if (!priorPlacement) return null;
    for (const [nodeId, occupancies] of priorPlacement.byNode) {
      if (occupancies.some((o) => o.service === serviceName)) return nodeId;
    }
    return null;
  };

  // Per service, resolve where its replicas land. Everything goes through the
  // planner in one batch (so later services see earlier ones' capacity use).
  const resolved = new Map<string, Resolved>();
  const clusterInputs: ClusterServiceInput[] = [];
  const domains = new Map<string, string | undefined>();
  for (const s of services) {
    const isWeb = s.domain !== undefined && s.port !== undefined;
    domains.set(
      s.name,
      resolveServiceDomain(
        { domain: s.domain, domainPattern: s.domainPattern ?? config.domainPattern, service: s.name },
        env,
      ),
    );

    if (reuseExistingImages) {
      // A restart / image-override rolls containers in place — pin to wherever the
      // service is published today so a capacity re-plan can't silently move it.
      const placements: Placement[] = [];
      for (const [nodeId, occupancies] of (priorPlacement as DeployedPlacementSnapshot).byNode) {
        const occ = occupancies.find((o) => o.service === s.name);
        if (!occ) continue;
        placements.push({ nodeId, replicas: occ.replicas });
      }
      if (placements.length === 0) {
        throw new CliError(`no published placement for service "${s.name}" — run a full deploy first`, {
          hint: "--restart / --image re-roll the service where it already runs; they can't place a new one",
        });
      }
      placements.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      resolved.set(s.name, {
        placements,
        pool: placements.map((p) => p.nodeId),
        edge: isWeb ? edgeNodeId : null,
        domain: domains.get(s.name),
      });
      continue;
    }

    clusterInputs.push({
      name: s.name,
      replicas: s.replicas,
      cpu: s.cpu,
      memory: s.memory,
      maxSurge: s.rollout.maxSurge,
      isWeb,
      hasVolumes: s.volumes.length > 0,
      stickyNodeId: s.volumes.length > 0 ? publishedNodeOf(s.name) : null,
    });
  }

  if (clusterInputs.length > 0) {
    // Auto-add app nodes when the current pool can't fit the services (instead of erroring
    // "reduce cpu/memory/replicas"). Bounded by the total replica count (you never need
    // more app nodes than replicas); disabled by --no-create / --restart / --image.
    // Added nodes are provisioned for real below (sized to their placement), spend-gated by
    // the same confirmation panel as any provision.
    const maxAdd = autoAddEnabled ? clusterInputs.reduce((n, s) => n + s.replicas, 0) : 0;
    const { plans, added } = planClusterPlacementAutoAdd(
      {
        clusterId: aws.clusterId,
        nodes: candidateNodes,
        services: clusterInputs,
      },
      { maxAdd, existingNodeIds: [...new Set([...nodes.keys(), ...clusterAppNodeIds, edgeNodeId])] },
    );
    for (const node of added) {
      candidateNodes.push(node);
      clusterAppNodeIds.push(node.nodeId);
    }
    if (added.length > 0 && !isJsonMode()) {
      log.info(
        `cluster "${aws.clusterId}" is at capacity — auto-adding ${added.length} app node(s) ` +
          `(${added.map((n) => color.cyan(n.nodeId)).join(", ")}) to fit the deploy.`,
      );
    }
    for (const plan of plans) {
      const decl = services.find((s) => s.name === plan.service) as ServiceDecl;
      const isWeb = decl.domain !== undefined && decl.port !== undefined;
      resolved.set(plan.service, {
        placements: plan.placements,
        pool: plan.pool,
        edge: isWeb ? edgeNodeId : null,
        domain: domains.get(plan.service),
      });
    }
  }

  const appNodeIds = new Set<string>();
  for (const r of resolved.values()) {
    for (const n of r.pool) appNodeIds.add(n);
  }

  // No two services in one deploy may project to the same host — the edge would
  // otherwise get two routes for one domain. Catches a malformed pattern early.
  const domainOwners = new Map<string, string>();
  for (const s of services) {
    const d = resolved.get(s.name)?.domain;
    if (d === undefined) continue;
    const prior = domainOwners.get(d);
    if (prior !== undefined) {
      throw new CliError(`services "${prior}" and "${s.name}" both resolve to domain "${d}"`, {
        hint: env !== undefined ? "give each service a distinct domainPattern" : "give each service a distinct domain",
      });
    }
    domainOwners.set(d, s.name);
  }

  // What each app node needs placed on it — so a missing node can be auto-sized to fit.
  const demandByNode = new Map<string, { cpu: number; memory: number; surgeCpu: number; surgeMemory: number }>();
  for (const s of services) {
    const r = resolved.get(s.name) as Resolved;
    for (const p of r.placements) {
      const d = demandByNode.get(p.nodeId) ?? { cpu: 0, memory: 0, surgeCpu: 0, surgeMemory: 0 };
      d.cpu += s.cpu * p.replicas;
      d.memory += s.memory * p.replicas;
      // Largest single surge wins (one service rolls at a time), per resource.
      const surge = Math.min(s.rollout.maxSurge, p.replicas);
      d.surgeCpu = Math.max(d.surgeCpu, s.cpu * surge);
      d.surgeMemory = Math.max(d.surgeMemory, s.memory * surge);
      demandByNode.set(p.nodeId, d);
    }
  }

  const candidateArchitecture = new Map(candidateNodes.map((n) => [n.nodeId, n.architecture]));
  const demands: NodeDemand[] = [...appNodeIds].map((nodeId) => {
    const d = demandByNode.get(nodeId) ?? { cpu: 0, memory: 0, surgeCpu: 0, surgeMemory: 0 };
    return {
      nodeId,
      architecture: candidateArchitecture.get(nodeId) ?? nodes.get(nodeId)?.architecture ?? "arm64",
      cpu: d.cpu,
      memory: d.memory,
      surgeCpu: d.surgeCpu,
      surgeMemory: d.surgeMemory,
    };
  });

  // Partition referenced nodes into ready / resume (paused) / create (missing) —
  // the dedicated edge first (an app node's security group references its edge's SG).
  const loadEntry = async (id: string): Promise<NodeRegistryEntry | null> => {
    const cached = nodes.get(id);
    if (cached) return cached;
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    return obj ? parseNodeRegistryEntry(obj.raw) : null;
  };
  const edgeAction = await planEdgeAction({
    edgeNodeId,
    load: loadEntry,
    allowCreate: opts.create !== false,
  });
  const plan = [
    edgeAction,
    ...(await buildProvisionPlan({
      demands,
      edgeNodeId,
      load: loadEntry,
      allowCreate: opts.create !== false,
    })),
  ];
  for (const a of plan) {
    if (a.kind === "ready" || a.kind === "resume") nodes.set(a.nodeId, a.entry);
  }
  const toCreate = plan.filter((a): a is Extract<NodeAction, { kind: "create" }> => a.kind === "create");

  // EC2-aware drift: an existing node's instance may have been stopped or
  // terminated in the AWS console. Reconcile EC2 reality against the registry
  // before publishing desired state into a node that can't run it.
  const repairEnabled = opts.repair !== false;
  const allowRecreate = repairEnabled && opts.recreate !== false;
  const existingEntries = plan
    .filter(
      (a): a is Extract<NodeAction, { kind: "ready" | "resume" }> =>
        a.kind === "ready" || a.kind === "resume",
    )
    .map((a) => a.entry)
    .filter((e) => e.instanceId); // registry-only nodes have no EC2 to reconcile
  const observations = await describeInstancesById(
    aws.ec2,
    existingEntries.map((e) => e.instanceId as string),
  );
  interface Repair {
    entry: NodeRegistryEntry;
    drift: NodeDrift;
  }
  const repairs: Repair[] = existingEntries
    .map((entry) => ({
      entry,
      drift: planNodeDrift(
        entry,
        observations.get(entry.instanceId as string) ?? { kind: "missing" },
        { allowRecreate },
      ),
    }))
    .filter((r) => r.drift.action.kind !== "noop");

  // --no-repair: refuse to publish into console-side drift; surface it loudly.
  const drifted = repairs.filter((r) => r.drift.drift !== "none");
  if (!repairEnabled && drifted.length > 0) {
    throw new CliError(
      `EC2 drift on ${drifted.length} node(s): ${drifted.map((r) => `${r.entry.nodeId} (${r.drift.drift})`).join(", ")}`,
      { hint: "run `launchpad node reconcile`, or drop --no-repair to auto-repair on deploy" },
    );
  }

  // A transitional instance (or a gone one with --no-recreate) can't be repaired now.
  const blockedMsgs = repairs.flatMap((r) =>
    r.drift.action.kind === "blocked" ? [`${r.entry.nodeId}: ${r.drift.action.reason}`] : [],
  );
  if (blockedMsgs.length > 0) {
    throw new CliError(`can't deploy — ${blockedMsgs.length} node(s) need attention:\n  ${blockedMsgs.join("\n  ")}`, {
      hint: "a terminated instance is replaced unless --no-recreate; otherwise fix it in the AWS console",
    });
  }

  // Anything that boots or replaces an instance is billable + needs confirmation.
  const bootsInstances =
    toCreate.length +
    repairs.filter((r) => r.drift.action.kind === "resume" || r.drift.action.kind === "recreate").length;

  // Auto-provision / repair whatever the config needs that isn't already running.
  if (toCreate.length > 0 || repairs.length > 0) {
    if (!isJsonMode()) {
      panel(opts.dryRun ? "Provisioning plan (dry run — nothing changed)" : "Provisioning plan", [
        ...toCreate.map(
          (a) =>
            `${color.green("+ create")} ${color.cyan(a.nodeId)} ${color.dim(
              `${a.role} · ${a.instanceType} (${sharesToVcpu(a.capacity.totalCpu)} vCPU · ${a.capacity.totalMemory} MB)`,
            )}${formatNodeMonthlyCost({
              nodeId: a.nodeId,
              role: a.role,
              instanceType: a.instanceType,
              billsEc2: true,
            })}`,
        ),
        ...repairs.map((r) => repairLine(r.entry, r.drift)),
      ]);
    }

    if (opts.dryRun) {
      for (const a of toCreate) nodes.set(a.nodeId, synthesizeEntry(aws, a));
    } else {
      if (bootsInstances > 0 && opts.yes !== true) {
        const ok = await confirm(
          `provision/repair ${toCreate.length + repairs.length} node(s)? ` +
            "A recreate boots a fresh instance (brief downtime).",
          false,
        );
        if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
      }

      // Resolve the AMIs + VPC once for the whole batch — one AMI per ROLE, since
      // the edge and app golden AMIs are different images.
      const rolesNeeded = new Set([
        ...toCreate.map((a) =>
          nodeAmiLookupKey({ role: provisionRoleOf(a.role), architecture: a.architecture }),
        ),
        ...repairs
          .filter((r) => r.drift.action.kind === "recreate")
          .map((r) =>
            nodeAmiLookupKey({
              role: provisionRoleOf(r.entry.role),
              architecture: r.entry.architecture,
            }),
          ),
      ]);
      const amiByRole = await resolveNodeAmiByRole(
        { ec2: aws.ec2, ssm: aws.ssm, region: aws.region, explicitAmiId: opts.ami },
        [...rolesNeeded].map((key) => {
          const [role, architecture] = key.split(":");
          return { role: role as "app" | "edge", architecture: architecture as "x86_64" | "arm64" };
        }),
      );
      const vpcId = toCreate.length > 0 ? await getDefaultVpcId(aws.ec2) : undefined;
      const agentVersion = readVersion();

      // Edges/both first — an app node's security group references its edge's SG,
      // and ingress must exist before app replicas health-check.
      const createOrder = [...toCreate].sort(
        (x, y) => (x.role === "app" ? 1 : 0) - (y.role === "app" ? 1 : 0),
      );
      for (const a of createOrder) {
        const spin = spinner(`provisioning ${a.nodeId} (${a.instanceType})…`).start();
        const ami = amiByRole.get(
          nodeAmiLookupKey({ role: provisionRoleOf(a.role), architecture: a.architecture }),
        );
        try {
          const entry = await provisionNode({
            aws,
            nodeId: a.nodeId,
            role: a.role,
            instanceType: a.instanceType,
            agentVersion,
            capacity: a.capacity,
            amiId: ami?.imageId,
            amiBootstrapMode: ami?.bootstrapMode,
            vpcId,
            edgeNodeId: a.edgeNodeId,
            onProgress: (t) => {
              spin.text = t;
            },
          });
          nodes.set(a.nodeId, entry);
          spin.succeed(`provisioned ${color.cyan(a.nodeId)} (${entry.instanceId})`);
        } catch (error) {
          if (spin.isSpinning) spin.fail(`provisioning ${a.nodeId} failed`);
          throw error;
        }
      }

      // Then drift repairs — the edge before app nodes, same reason.
      const repairOrder = [...repairs].sort(
        (x, y) => (x.entry.role === "app" ? 1 : 0) - (y.entry.role === "app" ? 1 : 0),
      );
      for (const r of repairOrder) {
        const verb = repairVerb(r.drift);
        const spin = spinner(`${verb.ing} ${r.entry.nodeId}…`).start();
        const ami = amiByRole.get(
          nodeAmiLookupKey({
            role: provisionRoleOf(r.entry.role),
            architecture: r.entry.architecture,
          }),
        );
        try {
          const updated = await applyNodeDrift({
            aws,
            entry: r.entry,
            action: r.drift.action,
            agentVersion,
            amiId: ami?.imageId,
            amiBootstrapMode: ami?.bootstrapMode,
            onProgress: (t) => {
              spin.text = t;
            },
          });
          nodes.set(r.entry.nodeId, updated);
          spin.succeed(`${verb.ed} ${color.cyan(r.entry.nodeId)}`);
        } catch (error) {
          if (spin.isSpinning) spin.fail(`${verb.ing} ${r.entry.nodeId} failed`);
          throw error;
        }
      }
    }
  }

  // Adopt the freshly created edge as the cluster's default (named clusters only —
  // the default cluster has no cluster.json; its edge is found via the registry).
  if (!opts.dryRun && clusterCfg && clusterCfg.defaultEdge === null) {
    await adoptEdgeIfUnset(aws, aws.clusterId, edgeNodeId);
  }

  await assertSecretsPresent(aws, services, ownerProject);

  const allNodeIds = [...appNodeIds];
  // The {service → image} to reuse without building: published images for --restart,
  // or the validated override tag for --image. null for a normal (build-and-push) deploy.
  const reuseImages =
    opts.restart === true
      ? await loadRestartImages(aws, services, ownerProject, allNodeIds)
      : opts.image !== undefined
        ? await loadOverrideImage(aws, config.project, services[0] as ServiceDecl, opts.image)
        : null;

  // Ensure ECR repos + immutable tags (one image per service, unless we reuse an existing one).
  const built: BuiltService[] = [];
  for (const decl of services) {
    const repoName = ecrRepositoryName(config.project, decl.name);
    const contextDir = resolve(dir, decl.context);
    const domain = resolved.get(decl.name)?.domain;
    // A managed database runs a pinned engine image (postgres:<version>) — there is
    // nothing to build or push. Pin the image and leave the ECR repo/tag fields empty so
    // the build loop, --changed, and --remote-build all skip it (it has no Dockerfile).
    if (decl.database !== undefined) {
      built.push({
        decl,
        repoName: "",
        repoUri: "",
        tag: "",
        image: databaseImage(decl.database),
        contextDir,
        dockerfilePath: resolve(dir, decl.dockerfile),
        domain,
      });
      continue;
    }
    if (reuseImages) {
      built.push({
        decl,
        repoName,
        repoUri: "",
        tag: "",
        image: reuseImages.get(decl.name) as string,
        contextDir,
        dockerfilePath: resolve(dir, decl.dockerfile),
        domain,
      });
      continue;
    }
    const repoUri = await ensureRepository(aws.ecr, repoName, {
      project: config.project,
      service: decl.name,
    });
    const tag = await computeImageTag(contextDir);
    built.push({
      decl,
      repoName,
      repoUri,
      tag,
      image: `${repoUri}:${tag}`,
      contextDir,
      dockerfilePath: resolve(dir, decl.dockerfile),
      domain,
    });
  }

  // Distribute replicas across each service's resolved nodes.
  const nodePlacements = new Map<string, NodeService[]>();
  for (const b of built) {
    const r = resolved.get(b.decl.name) as Resolved;
    for (const p of r.placements) {
      const list = nodePlacements.get(p.nodeId) ?? [];
      list.push({ built: b, replicas: p.replicas });
      nodePlacements.set(p.nodeId, list);
    }
  }

  const platformByService = new Map<string, string>();
  for (const b of built) {
    const r = resolved.get(b.decl.name) as Resolved;
    const architectures = new Set(
      r.placements.map((p) => {
        const node = nodes.get(p.nodeId);
        if (!node) {
          throw new CliError(`service "${b.decl.name}" was placed on unknown node "${p.nodeId}"`);
        }
        return node.architecture;
      }),
    );
    if (architectures.size > 1) {
      throw new CliError(`service "${b.decl.name}" spans mixed app-node architectures`, {
        hint: "keep app node pools homogeneous for now, or deploy the service to one architecture at a time",
      });
    }
    const architecture = [...architectures][0] ?? "arm64";
    platformByService.set(b.decl.name, dockerPlatformForArchitecture(architecture));
  }

  // Nodes this footprint occupies today but the new placement no longer targets.
  // Skipped for partial (--service / --changed) deploys: a subset deploy can't see the
  // project's full intended placement, so "vacated" would wrongly include the other
  // services' nodes (and the per-node merge already preserves those services in place).
  const vacatedNodeIds =
    priorPlacement && !partialDeploy
      ? priorPlacement.occupiedNodeIds.filter((id) => !nodePlacements.has(id))
      : [];

  // Capacity pre-flight per node BEFORE building.
  for (const [id, placed] of nodePlacements) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, id));
    const state = existing
      ? parseDesiredStateOrEmpty(id, existing.raw, nowIso())
      : emptyDesiredState(id, nowIso());
    assertCapacity(id, node, capacityDemands(ownerProject, state, placed, partialDeploy));
    printCapacitySummary(id, node, placed);
  }

  const placementPlan = buildPlacementPlan(
    built.map((b) => b.decl),
    resolved,
  );
  printPlacementPlan(placementPlan);

  if (opts.dryRun) {
    log.warn("dry run — no images pushed, no state written");
    if (isJsonMode()) {
      printJson({
        dryRun: true,
        provision: {
          create: toCreate.map((a) => ({
            nodeId: a.nodeId,
            role: a.role,
            instanceType: a.instanceType,
            edge: a.edgeNodeId ?? null,
          })),
          repair: repairs.map((r) => ({
            nodeId: r.entry.nodeId,
            drift: r.drift.drift,
            action: r.drift.action.kind,
          })),
        },
        placements: [...nodePlacements].map(([nodeId, placed]) => ({
          nodeId,
          services: placed.map((p) => ({ service: p.built.decl.name, replicas: p.replicas, image: p.built.image })),
        })),
        placementPlan,
        removals: vacatedNodeIds,
      });
    }
    return;
  }

  if (!reuseExistingImages) {
    if (opts.remoteBuild === true) {
      await runRemoteBuilds(aws, built, ownerProject, platformByService);
    } else {
      const prep = spinner("preparing local Docker build environment…").start();
      try {
        await checkDocker();
        await ensureBuilder();
        prep.text = "logging in to ECR…";
        const auth = await getEcrAuth(aws.ecr);
        await dockerLoginEcr(auth);
        prep.succeed("Docker builder ready");
      } catch (error) {
        if (prep.isSpinning) prep.fail("Docker build environment is not ready");
        throw error;
      }
      for (const b of built) {
        // A managed database runs a pinned engine image — nothing to build or push.
        if (isDatabaseService(b.decl)) continue;
        if (await imageExists(aws.ecr, b.repoName, b.tag)) {
          log.step(`${color.cyan(b.decl.name)}: image ${color.dim(b.tag)} already in ECR — skipping build`);
          continue;
        }
        const platform = platformByService.get(b.decl.name) ?? "linux/arm64";
        const spin = spinner(`building ${b.decl.name} → ${b.tag} (${platform})`).start();
        try {
          await buildAndPush({
            contextDir: b.contextDir,
            dockerfile: b.dockerfilePath,
            imageUri: b.image,
            platform,
            verbose: opts.verbose,
          });
          spin.succeed(`built + pushed ${color.cyan(b.decl.name)} → ${color.dim(b.tag)}`);
        } catch (error) {
          spin.fail(`build failed for ${b.decl.name}`);
          throw error;
        }
      }
    }
  }

  // A managed database with a backup config dumps to the dedicated backups bucket —
  // ensure it exists (hardened: private + encrypted + versioned) once before publishing
  // the service's backup config (which names this bucket). Skipped on a dry run.
  if (!opts.dryRun && built.some((b) => b.decl.backup !== undefined)) {
    const spin = spinner("ensuring the database-backups bucket…").start();
    try {
      await ensureBackupsBucket(aws.s3, aws.accountId, aws.region, aws.clusterId);
      spin.succeed(`backups bucket ${color.cyan(backupsBucketName(aws.accountId, aws.region))} ready`);
    } catch (error) {
      if (spin.isSpinning) spin.fail("could not set up the database-backups bucket");
      throw error;
    }
  }

  const previousContainers = new Map<string, string[]>();
  if (opts.restart === true) {
    for (const [id, placed] of nodePlacements) {
      for (const p of placed) {
        previousContainers.set(
          `${id}/${p.built.decl.name}`,
          await loadRunningContainerIds(aws, id, ownerProject, p.built.decl.name),
        );
      }
    }
  }

  // Every node that received a desired-state write this deploy — each needs a
  // subscribed SQS queue before the single cluster-wide SNS notification fires.
  const touchedNodeIds = new Set<string>();

  // Publish desired state per node.
  for (const [id, placed] of nodePlacements) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const incoming = placed.map((p) =>
      toServiceConfig(
        aws,
        ownerProject,
        p.built,
        p.replicas,
        (resolved.get(p.built.decl.name) as Resolved).edge,
        env,
        opts.restart === true,
      ),
    );
    await publishDesired(aws, id, node, ownerProject, incoming, partialDeploy);
    touchedNodeIds.add(id);
    log.success(`published desired state → ${color.cyan(id)}`);
  }

  // Cleanup AFTER the additions: transient over-provisioning beats a window where
  // a moved service has zero replicas anywhere. The vacated node's agent stops the
  // containers on its next poll (removal isn't convergence-watched).
  for (const id of vacatedNodeIds) {
    let entry = nodes.get(id) ?? null;
    if (!entry) {
      const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
      entry = obj ? parseNodeRegistryEntry(obj.raw) : null;
    }
    if (!entry) {
      log.warn(`node "${id}" previously hosted ${ownerProject} but is gone — skipping cleanup`);
      continue;
    }
    await publishDesired(aws, id, entry, ownerProject, []);
    touchedNodeIds.add(id);
    log.success(`removed ${color.cyan(ownerProject)} from ${color.cyan(id)} (no longer placed there)`);
  }

  // Push half of the hybrid model: ensure each touched node (plus the edge that routes
  // them) has an SQS queue subscribed to the cluster topic, then publish ONE
  // cluster-wide notification so every agent fetches immediately instead of waiting for
  // its 60s poll. Entirely best-effort — any failure here leaves polling as the fallback
  // and never blocks the deploy.
  if (snsTopicArn && !opts.dryRun) {
    touchedNodeIds.add(edgeNodeId);
    for (const id of touchedNodeIds) {
      try {
        await ensureNodeQueue(aws.sqs, aws.sns, aws.clusterId, id, snsTopicArn);
      } catch (error) {
        log.warn(
          `could not wire SNS notifications for node ${id} (agent will poll): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await publishDeployNotification(aws.sns, snsTopicArn, {
        type: "config-changed",
        cluster: aws.clusterId,
        timestamp: new Date().toISOString(),
        version: 1,
      });
    } catch (error) {
      log.warn(
        `SNS publish failed (agents will pick up changes on next poll): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!opts.dryRun) {
    await writeConfigBaseline(aws, config, ownerProject);
    // Register this component in the project's index — what `project list/show`
    // aggregation, `destroy --project` fan-out, and the uniqueness pre-flight
    // read. Records the FULL config's service names even on a partial deploy.
    await upsertProjectIndex(aws, {
      project: config.project,
      component: config.component,
      services: config.service.map((s) => s.name),
      now: nowIso(),
    });
  }

  // Update the advisory edge.json with this project's fronted domains.
  {
    const edgeDomains: string[] = [];
    for (const r of resolved.values()) {
      if (r.edge === edgeNodeId && r.domain) edgeDomains.push(r.domain);
    }
    if (edgeDomains.length > 0) await publishEdgeConfig(aws, edgeNodeId, edgeDomains);
  }

  const targets: WatchTarget[] = [];
  for (const [id, placed] of nodePlacements) {
    for (const p of placed) {
      targets.push({
        nodeId: id,
        project: ownerProject,
        service: p.built.decl.name,
        image: p.built.image,
        // A cron service idles with zero running replicas — converged means "the
        // agent reported it without error", so expect 0 instead of waiting for a
        // long-running replica that will never exist.
        expectedReplicas: p.built.decl.cron !== undefined ? 0 : p.replicas,
        previousContainerIds: previousContainers.get(`${id}/${p.built.decl.name}`),
      });
    }
  }

  // A-record targets for the post-deploy DNS checklist: each web domain → the
  // Elastic IP of the cluster's dedicated edge. With a domainPattern, one wildcard
  // record covers every env projection — surface that in the panel too.
  const dnsWildcard = config.domainPattern !== undefined ? wildcardForPattern(config.domainPattern) : null;
  const dnsTargets: DnsTarget[] = [];
  const seenDnsDomains = new Set<string>();
  for (const b of built) {
    if (!b.domain || seenDnsDomains.has(b.domain)) continue;
    seenDnsDomains.add(b.domain);
    const r = resolved.get(b.decl.name) as Resolved;
    if (!r.edge) continue;
    dnsTargets.push({
      domain: b.domain,
      frontingNode: r.edge,
      viaEdge: true,
      eip: nodes.get(r.edge)?.publicIp ?? null,
    });
  }

  // One deploy-history event per successful publish: what ran, where it landed, and
  // (when waited) whether it converged. `kind` records the path the deploy took.
  const deployKind: DeployKind =
    opts.image !== undefined ? "image" : opts.restart === true ? "restart" : "build";
  const eventServices = built.map((b) => ({
    service: b.decl.name,
    image: b.image,
    replicas: (resolved.get(b.decl.name) as Resolved).placements.reduce((n, p) => n + p.replicas, 0),
  }));

  // Env-marker bookkeeping BEFORE the convergence wait so the env is enumerable
  // (`destroy --list-envs`) even when the watch is interrupted.
  if (env !== undefined) {
    await recordPreviewState(aws, config, env, previewTtlMs);
  }

  if (opts.wait === false) {
    reportPublished(built, ownerProject, placementPlan, dnsTargets, dnsWildcard, hideEdgeIp(opts));
    await recordDeployEvent(aws, { ownerProject, env, kind: deployKind, services: eventServices, converged: null });
    return;
  }
  const converged = await watchAndReport(
    aws,
    targets,
    parseTimeoutMs(opts.timeout, DEFAULT_CONVERGE_TIMEOUT_SECONDS, "pass whole seconds ≥ 1, e.g. --timeout 180"),
    built,
    placementPlan,
    dnsTargets,
    dnsWildcard,
    hideEdgeIp(opts),
  );
  await recordDeployEvent(aws, { ownerProject, env, kind: deployKind, services: eventServices, converged });
}

/**
 * Whether to mask the edge IP in the human DNS panel. On by default in GitHub Actions
 * (and any run with `LAUNCHPAD_HIDE_IP` set) so a public deploy log can't leak the origin
 * IP behind a proxy/CDN; `--hide-ip` forces it on, `--show-ip` forces it off. Affects the
 * human panel only — `--json` keeps the real IP (it's a machine contract, not a log).
 */
function hideEdgeIp(opts: DeployOptions): boolean {
  if (opts.showIp === true) return false;
  return opts.hideIp === true || !!process.env.LAUNCHPAD_HIDE_IP || process.env.GITHUB_ACTIONS === "true";
}

function reportPublished(
  built: BuiltService[],
  project: string,
  placementPlan: PlacementPlanEntry[],
  dnsTargets: DnsTarget[],
  dnsWildcard: string | null,
  hideIp: boolean,
): void {
  if (isJsonMode()) {
    printJson({
      published: true,
      project,
      services: built.map((b) => ({ service: b.decl.name, image: b.image })),
      placementPlan,
      dns: dnsTargets,
    });
    return;
  }
  panel("Published", [
    ...built.map((b) => `${color.cyan(`${project}/${b.decl.name}`)} ${color.dim(`×${b.decl.replicas}`)}`),
    color.dim("the agent on each node will reconcile to this state"),
  ]);
  const dnsLines = buildDnsChecklist(dnsTargets, dnsWildcard, { hideIp });
  if (dnsLines.length > 0) panel("DNS — point your domains here", dnsLines);
}

async function watchAndReport(
  aws: AwsEnv,
  targets: WatchTarget[],
  timeoutMs: number,
  built: BuiltService[],
  placementPlan: PlacementPlanEntry[],
  dnsTargets: DnsTarget[],
  dnsWildcard: string | null,
  hideIp: boolean,
): Promise<boolean> {
  const spin = spinner("waiting for nodes to converge…").start();
  let final: WatchResult[] = [];
  await waitForConvergence(aws.s3, aws.bucket, aws.clusterId, targets, timeoutMs, (results) => {
    final = results;
    const running = results.filter((r) => r.ok).length;
    spin.text = `converging ${running}/${results.length} services…`;
  });

  const allConverged = final.every((r) => r.ok);
  if (allConverged) {
    spin.succeed("all services running");
  } else {
    spin.stop();
  }

  if (isJsonMode()) {
    printJson({
      converged: allConverged,
      services: final.map((r) => ({ ...r.target, state: r.state, ok: r.ok, message: r.message })),
      placementPlan,
      dns: dnsTargets,
    });
    if (!allConverged) process.exitCode = 1;
    return allConverged;
  }

  for (const r of final) {
    const label = `${r.target.project}/${r.target.service}`;
    if (r.ok) log.success(`${color.cyan(label)} running (${r.target.expectedReplicas} replicas)`);
    else log.warn(`${color.cyan(label)} ${color.dim(`(${r.state})`)} — ${r.message}`);
  }

  const webTargets = built.filter((b) => b.domain);
  if (webTargets.length > 0) {
    panel(
      "URLs",
      webTargets.map((b) => `https://${b.domain}`),
    );
    const dnsLines = buildDnsChecklist(dnsTargets, dnsWildcard, { hideIp });
    if (dnsLines.length > 0) panel("DNS — point your domains here", dnsLines);
  }

  if (!allConverged) {
    process.exitCode = 1;
    log.dim("not all services converged — check `launchpad status` or the node's agent logs");
  }
  return allConverged;
}

export function registerDeploy(program: Command): void {
  const cmd = program
    .command("deploy")
    .description("Build, push, and publish your services' desired state to their nodes")
    .option("--service <name>", "deploy only this service (default: every service in launch-pad.toml)")
    .option(
      "--changed <ref>",
      "deploy only services whose build context/Dockerfile changed since this git ref (monorepo CI)",
    )
    .option("--env <name>", "deploy as a named environment: projects each domain + namespaces the footprint")
    .option("--ttl <duration>", "env lifetime (30m/72h/7d) — `destroy --prune-expired` tears the env down after it (needs --env)")
    .option("--no-create", "fail on a missing node instead of auto-provisioning it")
    .option("--no-repair", "fail on console-side EC2 drift instead of repairing it before publishing")
    .option("--no-recreate", "repair stopped nodes but fail (don't replace) a terminated instance")
    .option("--no-wait", "don't wait for the agent to report convergence")
    .option(
      "--timeout <seconds>",
      "how long to wait for convergence",
      String(DEFAULT_CONVERGE_TIMEOUT_SECONDS),
    )
    .option("--yes", "skip confirmation prompts (required to auto-provision in CI)")
    .option("--hide-ip", "mask the edge IP in the DNS panel (default under GitHub Actions / LAUNCHPAD_HIDE_IP)")
    .option("--show-ip", "always show the edge IP, even under CI auto-hide")
    .option("--dry-run", "do everything except push images, write state, or create nodes")
    .option("--ami <id>", "AMI id for auto-provisioned/recreated nodes")
    .option("--restart", "skip build/push and roll containers (picks up secret/env changes)")
    .option(
      "--allow-new-services",
      "permit new [[service]] blocks in launch-pad.toml (e.g. adding admin to an existing footprint)",
    )
    .option(
      "--image <uri>",
      "skip build/push and redeploy an existing ECR tag of one --service (rollback / promote)",
    )
    .option(
      "--remote-build",
      "build images on AWS CodeBuild instead of local docker (slim CI runners)",
    )
    .addHelpText(
      "after",
      [
        "",
        "Missing nodes (the cluster's dedicated edge + the app nodes the scheduler needs)",
        "are auto-provisioned, and paused nodes resumed, after a confirmation prompt —",
        "pass --yes in CI, or --no-create to opt out.",
        "",
        "Before publishing, deploy reconciles each node's EC2 reality against the registry:",
        "a console-stopped node is started, a console-started node is synced, and a",
        "terminated instance is recreated under the same node id (the edge keeps its Elastic IP).",
        "Use --no-repair to fail on drift, or --no-recreate to allow only resume/sync.",
        "",
        "Placement is automatic: the scheduler bin-packs services across the cluster's app",
        "nodes by free CPU/memory (spreads across empty nodes when possible; stacks when",
        "necessary), auto-adding app nodes when the pool is full. Web traffic always routes",
        "through the cluster's dedicated edge node (Caddy on its own t4g.nano by default) —",
        "every cluster is at least 2 nodes: the edge + 1 app node. A service with",
        "[[service.volumes]] is sticky: it stays on the node it first landed on (its data",
        "lives on that node's disk). The resolved placement map prints on every deploy.",
        "",
        "Config lock: after a project's first deploy, only cpu, memory, replicas, env,",
        "secrets, domain, and domainPattern may change in launch-pad.toml. Identity edits",
        "(rename, port, healthCheck, rollout, …) abort deploy before the build — there is",
        "no bypass flag. Use `launchpad scale <field>` and `launchpad config set` to make the",
        "allowed edits from the CLI. (When iterating on this lock locally, run the workspace",
        "CLI — `pnpm --filter @agentsystemlabs/launch-pad dev -- deploy`.)",
        "",
        "Monorepo: --changed <ref> deploys only the services whose docker build context",
        "or Dockerfile differs from <ref> (committed, uncommitted, or untracked) — wire it",
        "into CI as `launchpad deploy --changed origin/main --yes`. Unchanged services keep",
        "their published image, and a sibling on a shared node is preserved (a",
        "subset deploy upserts, it doesn't replace the project's footprint). With no service",
        "changed it's a clean no-op (exit 0). Config-only edits (cpu/replicas/env) aren't build",
        "inputs — use `scale` / `config set` or a full `deploy` for those.",
        "",
        "Examples:",
        "  $ launchpad deploy",
        "  $ launchpad deploy --service web --no-wait",
        "  $ launchpad deploy --changed origin/main --yes  # CI: deploy only what changed",
        "  $ launchpad deploy --env staging          # parallel env on the shared edge",
        "  $ launchpad deploy --yes        # auto-provision without prompting",
        "  $ launchpad deploy --no-create  # error if a node is missing",
        "  $ launchpad deploy --no-repair  # error on console-side EC2 drift",
        "  $ launchpad deploy --service web --image <uri>  # redeploy an existing tag (rollback)",
        "",
        "--remote-build builds every image on AWS CodeBuild instead of local docker: deploy",
        "uploads each service's build context (a tarball honoring .dockerignore) to the state",
        "bucket, a per-cluster CodeBuild project builds + pushes the same immutable architecture-matched",
        "tag the local path would, and the deploy continues unchanged. First use creates the",
        "project + a least-privilege service role (~30–60s); CodeBuild bills per build minute.",
        "Ideal for CI runners without a docker daemon: `launchpad deploy --remote-build --yes`.",
        "",
        "--image redeploys an existing immutable ECR tag of ONE --service without building —",
        "for rollback or promoting a known-good build. The URI must be in that service's own",
        "ECR repo and the tag must already exist; the service must already be deployed (it",
        "re-rolls in place). Container config (cpu/memory/replicas/env/secrets) comes from the",
        "current launch-pad.toml, so the config lock still applies.",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runDeploy(mergedOpts<DeployOptions>(command));
    });

  applyGlobalOptions(cmd);
}
