import { randomBytes } from "node:crypto";
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
  PROTOCOL_VERSION,
  type ServiceConfig,
  type ServiceDecl,
  type ServiceSchedule,
  type ServiceTopology,
  assertConfigLockAllowed,
  baselineFromDeployedFootprints,
  buildDeployEvent,
  CONFIG_LOCK_MUTABLE_HINT,
  checkCapacity,
  configBaselineKey,
  deployEventKey,
  type DeployKind,
  containerEnvForDeploy,
  findEnvSecretConflicts,
  desiredKey,
  ecrRepositoryName,
  parseEcrImageUri,
  parseConfigBaseline,
  snapshotConfigBaseline,
  emptyDesiredState,
  envProject,
  LABEL_REGEX,
  mergeProjectServices,
  nodeRegistryKey,
  parseDesiredState,
  parseNodeRegistryEntry,
  parseNodeStatus,
  resolveServiceDomain,
  secretRefsForService,
  secretParameterPath,
  sharesToVcpu,
  statusKey,
  targetNodes,
  usesClusterPlacement,
} from "@agentsystemlabs/launch-pad-shared";
import { getExistingSecretPaths } from "../aws/ssm-secrets";
import { type AwsEnv, prepareAws } from "../aws/context";
import { describeInstancesById, getDefaultVpcId } from "../aws/ec2";
import { ensureRepository, getEcrAuth, imageExists } from "../aws/ecr";
import { getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { getClusterConfig } from "../cluster/store";
import { loadConfig } from "../config/load";
import { rememberClusterTarget } from "../config/local";
import { buildAndPush, checkDocker, computeImageTag, dockerLoginEcr, ensureBuilder } from "../deploy/build";
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
  distributeReplicas,
  type Placement,
  planClusterPlacementAutoAdd,
} from "../deploy/placement";
import { buildCandidateNodes, demandsOf } from "../deploy/candidate-nodes";
import {
  estimateProvisionCost,
  formatProvisionCostLines,
  formatProvisionCostSummary,
  type NodeCostInput,
} from "../cost/estimate";
import { buildDnsChecklist, type DnsTarget } from "../deploy/dns-panel";
import { buildProvisionPlan, type NodeAction, type NodeDemand } from "../deploy/provision-plan";
import { waitForConvergence, type WatchResult, type WatchTarget } from "../deploy/watch";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { DEFAULT_AGENT_TYPE, defaultAgentTypeForBootstrap, type AgentType } from "../provision/agent-bundle";
import { resolveNodeAmi } from "../provision/golden-ami";
import { provisionNode } from "../provision/provision-node";
import { panel, table } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";
import { assertValidNodeId } from "../validate-node-id";
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
 * Name of the single node auto-created when deploying cluster-placed services to an
 * otherwise-empty cluster (empty-cluster bootstrap). Mirrors the `app-<n>` naming the
 * capacity auto-add uses, so a bootstrap + later scale-out read as one series.
 */
const BOOTSTRAP_NODE_ID = "app-1";

export interface DeployOptions extends GlobalOpts {
  service?: string;
  node?: string;
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
  /** Agent runtime to install on auto-provisioned nodes: "rust" (default) or "ts". */
  agent?: string;
  /** AMI used for auto-provisioned/recreated nodes. */
  ami?: string;
  /** Skip build/push; re-publish desired state with restartAt to roll containers. */
  restart?: boolean;
  /** Skip build/push; publish an existing immutable ECR tag (rollback / promote). Needs --service. */
  image?: string;
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

function parseAgentType(value: string | undefined): AgentType | undefined {
  if (value === undefined) return undefined;
  if (value === "ts" || value === "rust") return value;
  throw new CliError(`invalid --agent "${value}" (expected ts | rust)`);
}

/** A stand-in registry entry for a to-be-created node, so a `--dry-run` can run the
 * capacity/placement preview without provisioning anything. */
function synthesizeEntry(aws: AwsEnv, a: Extract<NodeAction, { kind: "create" }>): NodeRegistryEntry {
  return {
    nodeId: a.nodeId,
    clusterId: aws.clusterId,
    instanceId: null,
    instanceType: a.instanceType,
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

/** Nodes touched by this provision/repair batch — used for the pre-confirm cost estimate. */
function provisionCostNodes(
  toCreate: Extract<NodeAction, { kind: "create" }>[],
  repairs: Array<{ entry: NodeRegistryEntry; drift: NodeDrift }>,
): NodeCostInput[] {
  const nodes: NodeCostInput[] = toCreate.map((a) => ({
    nodeId: a.nodeId,
    role: a.role,
    instanceType: a.instanceType,
    billsEc2: true,
  }));
  for (const r of repairs) {
    const boots =
      r.drift.action.kind === "resume" || r.drift.action.kind === "recreate";
    nodes.push({
      nodeId: r.entry.nodeId,
      role: r.entry.role,
      instanceType: r.entry.instanceType,
      billsEc2: boots,
    });
  }
  return nodes;
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
        entry.role === "app" ? "instance gone — same id (VPC-private)" : "instance gone — same id + Elastic IP",
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
    ingress:
      b.domain !== undefined && b.decl.port !== undefined
        ? { domain: b.domain, port: b.decl.port, edge: resolvedEdge }
        : null,
    healthCheck: b.decl.healthCheck
      ? { ...b.decl.healthCheck, port: b.decl.healthCheck.port ?? b.decl.port }
      : null,
    rollout: b.decl.rollout,
    volumes: b.decl.volumes.map((v) => ({ ...v })),
  };
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
    hint: "set them with `launch-pad secret set <KEY> --service <name>`",
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
/** Full demands a node carries after this deploy (other projects + this project's placements). */
function capacityDemands(
  project: string,
  state: DesiredState,
  placed: NodeService[],
): CapacityServiceDemand[] {
  const others = demandsOf(state.services.filter((s) => s.project !== project));
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
  return [...others, ...incoming];
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

/**
 * Persistent volumes are mounted only by the TypeScript agent today. Publishing a
 * volume-bearing service to a rust-agent node would parse fine but silently drop the
 * mount (losing the data), so refuse it up front with a clear remedy.
 */
export function assertVolumesSupported(nodeId: string, node: NodeRegistryEntry, placed: NodeService[]): void {
  if (node.agentType !== "rust") return;
  const withVolumes = placed.filter((p) => p.built.decl.volumes.length > 0).map((p) => p.built.decl.name);
  if (withVolumes.length === 0) return;
  throw new CliError(
    `node "${nodeId}" runs the rust agent, which doesn't mount persistent volumes yet — ` +
      `service(s) ${withVolumes.join(", ")} declare [[service.volumes]]`,
    { hint: `re-create the node with the TypeScript agent: launch-pad node create ${nodeId} --agent ts` },
  );
}

/** A service's resolved placement: where its replicas land and the edge fronting it. */
interface Resolved {
  placements: Placement[];
  /** Every node considered (pinned targets, or the full eligible cluster pool) —
   * all of them are drift-checked/repaired even when a node receives zero replicas. */
  pool: string[];
  edge: string | null;
  domain?: string | undefined;
  schedule: ServiceSchedule;
  topology: ServiceTopology;
  /** True when placement came from explicit `node`/`nodes` (or --node). */
  pinned: boolean;
}

interface PlacementPlanEntry {
  service: string;
  placements: Placement[];
  edge: string | null;
  topology: ServiceTopology;
  schedule: ServiceSchedule;
  pinned: boolean;
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
      topology: r.topology,
      schedule: r.schedule,
      pinned: r.pinned,
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
      const mode = e.pinned ? "pinned" : `${e.schedule} · ${e.topology}`;
      return `${color.cyan(e.service)} → ${where}${via} ${color.dim(`(${mode})`)}`;
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

/** Read → merge → capacity-check → conditional write, retrying on concurrent writes. */
export async function publishDesired(
  aws: AwsEnv,
  nodeId: string,
  node: NodeRegistryEntry,
  project: string,
  incoming: ServiceConfig[],
): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
    const state = existing ? parseDesiredState(existing.raw) : emptyDesiredState(nodeId, nowIso());
    const merged = mergeProjectServices(state.services, project, incoming);
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
    hint: `${CONFIG_LOCK_MUTABLE_HINT} — revert the other edits (or use \`launch-pad scale\` / \`launch-pad config set\` for the allowed ones)`,
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
      baseline: baselineFromDeployedFootprints(ownerProject, footprints, nowIso()),
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

/**
 * Reject any launch-pad.toml change after the first deploy except the mutable
 * post-deploy fields (cpu, memory, replicas, env, secrets — see
 * CONFIG_LOCK_MUTABLE_HINT). Runs BEFORE any build / ECR push / S3 write, so a
 * locked-field change aborts deploy immediately. There is no bypass flag; the
 * allowed edits have ergonomic commands (`scale`, `config set`, `secret`).
 */
export async function enforceConfigLock(
  aws: AwsEnv,
  config: LaunchPadConfig,
  ownerProject: string,
  opts: { node?: string },
): Promise<void> {
  const deployed = await loadLockBaseline(aws, ownerProject);
  if (!deployed) {
    log.dim(`config lock: no prior deploy for ${color.cyan(ownerProject)} — recording a baseline after this deploy`);
    return;
  }
  log.step(`config lock: comparing launch-pad.toml against ${deployed.source}`);

  if (opts.node) {
    throw new CliError(`--node cannot be used after the initial deploy of "${ownerProject}"`, {
      hint: `placement is locked — ${CONFIG_LOCK_MUTABLE_HINT}; drop --node`,
    });
  }

  const current = snapshotConfigBaseline(config, nowIso());
  try {
    assertConfigLockAllowed(deployed.baseline, current, { baselineFromDesired: deployed.fromDesired });
  } catch (error) {
    configLockError(error);
  }
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

export async function runDeploy(opts: DeployOptions): Promise<void> {
  const { config, dir } = loadConfig();

  const requestedAgentType = parseAgentType(opts.agent);

  const env = opts.env;
  if (env !== undefined && !LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label), e.g. staging, dev, pr-42",
    });
  }
  // The footprint owner: base project, or `<project>-<env>` so an env coexists with prod.
  const ownerProject = envProject(config.project, env);

  let services = config.service;
  if (opts.service) {
    services = services.filter((s) => s.name === opts.service);
    if (services.length === 0) {
      throw new CliError(`no service named "${opts.service}" in launch-pad.toml`, {
        hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
      });
    }
  }
  if (opts.node) {
    assertValidNodeId(opts.node);
    for (const s of services) {
      if (s.schedule !== "even" || s.topology !== "auto") {
        log.warn(`service "${s.name}": schedule/topology are ignored with --node (placement pinned to ${opts.node})`);
      }
    }
    services = services.map((s) => ({ ...s, node: opts.node as string, nodes: undefined }));
  }

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

  await enforceConfigLock(aws, config, ownerProject, opts);

  // Resolve the cluster's default edge + (when any service targets the cluster) its app nodes.
  const clusterCfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);
  const clusterDefaultEdge = clusterCfg?.defaultEdge ?? null;
  let nodes = new Map<string, NodeRegistryEntry>();
  let clusterAppNodeIds: string[] = [];
  // The capacity scheduler's view of each eligible node (S3-lexicographic order —
  // load-bearing for `schedule = "even"`, which must match legacy round-robin).
  let candidateNodes: CandidateNode[] = [];
  // Where this footprint is published today — drives --restart pinning and the
  // post-publish cleanup of nodes the new placement vacated.
  let priorPlacement: DeployedPlacementSnapshot | null = null;
  const anyClusterPlaced = services.some((s) => usesClusterPlacement(s));
  // Auto-add app nodes on capacity pressure is on by default for cluster-placed deploys
  // (off for --restart/--image, which re-roll a published placement, and --no-create).
  const autoAddEnabled = anyClusterPlaced && !reuseExistingImages && opts.create !== false;
  // `schedule = "capacity"` needs each node's committed demand to pack; so does auto-add's
  // even-overflow check (so it doesn't add a node a sibling project already fills). `even`
  // deploys without auto-add skip the per-node desired.json reads; --restart/--image too.
  const needsCapacitySnapshot =
    !reuseExistingImages &&
    (autoAddEnabled || services.some((s) => usesClusterPlacement(s) && s.schedule === "capacity"));
  if (anyClusterPlaced) {
    ({ nodes, clusterAppNodeIds, candidateNodes } = await buildCandidateNodes(aws, ownerProject, {
      needsCapacitySnapshot,
    }));
    // Empty-cluster bootstrap: a fresh cluster has no app/both pool to place onto. Unless
    // --no-create / --restart / --image, synthesize a single placement target so the planner
    // can place onto it — `deploy` then auto-provisions the real node (sized to fit, role
    // inferred, plus any edge a split service needs), mirroring the default cluster's
    // single-node auto-provision. --restart/--image have nothing published to re-roll, and
    // --no-create opts out of provisioning, so both fall through to the error below.
    if (clusterAppNodeIds.length === 0 && !reuseExistingImages && opts.create !== false) {
      const seed = bootstrapCandidateNode(BOOTSTRAP_NODE_ID);
      candidateNodes.push(seed);
      clusterAppNodeIds.push(seed.nodeId);
      if (!isJsonMode()) {
        log.info(
          `cluster "${aws.clusterId}" has no nodes yet — bootstrapping its first node ` +
            `"${BOOTSTRAP_NODE_ID}" to place ${color.cyan("cluster-scheduled")} services on.`,
        );
      }
    }
    if (clusterAppNodeIds.length === 0) {
      throw new CliError(`cluster "${aws.clusterId}" has no app nodes to place services on`, {
        hint: reuseExistingImages
          ? "run a full deploy first to place the service, then --restart/--image can re-roll it"
          : `create one: launch-pad node create ${BOOTSTRAP_NODE_ID} --cluster ${aws.clusterId} --role both (or drop --no-create to auto-provision it)`,
      });
    }
    priorPlacement = await loadDeployedPlacement(aws.s3, aws.bucket, aws.clusterId, ownerProject);
  }

  // Per service, resolve where its replicas land + the edge that fronts it.
  // Pinned services resolve directly; cluster-placed services go through the
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

    if (!usesClusterPlacement(s)) {
      const nodeIds = targetNodes(s);
      const edge = isWeb ? (s.edge ?? clusterDefaultEdge) : null;
      if (isWeb && nodeIds.length > 1 && !edge) {
        throw new CliError(`service "${s.name}" spans ${nodeIds.length} nodes but has no edge to load-balance them`, {
          hint: `add edge = "<edge-node-id>" to the service`,
        });
      }
      resolved.set(s.name, {
        placements: distributeReplicas(nodeIds, s.replicas),
        pool: nodeIds,
        edge,
        domain: domains.get(s.name),
        schedule: s.schedule,
        topology: s.topology,
        pinned: true,
      });
      if (s.edge && nodeIds.length === 1 && nodeIds[0] === s.edge) {
        log.warn(
          `service "${s.name}": edge and node are both "${s.edge}" — co-located mode; omit edge for the same result`,
        );
      }
      continue;
    }

    if (reuseExistingImages) {
      // A restart / image-override rolls containers in place — pin to wherever the
      // service is published today so a capacity re-plan can't silently move it.
      const placements: Placement[] = [];
      let publishedEdge: string | null = null;
      for (const [nodeId, occupancies] of (priorPlacement as DeployedPlacementSnapshot).byNode) {
        const occ = occupancies.find((o) => o.service === s.name);
        if (!occ) continue;
        placements.push({ nodeId, replicas: occ.replicas });
        publishedEdge = occ.ingress?.edge ?? null;
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
        edge: publishedEdge,
        domain: domains.get(s.name),
        schedule: s.schedule,
        topology: s.topology,
        pinned: false,
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
      explicitEdge: s.edge ?? null,
      schedule: s.schedule,
      topology: s.topology,
    });
  }

  if (clusterInputs.length > 0) {
    // Seed the candidates with this deploy's pinned placements so the capacity
    // scheduler sees nodes that pinned services are about to occupy.
    for (const s of services) {
      const r = resolved.get(s.name);
      if (!r?.pinned) continue;
      for (const p of r.placements) {
        const cn = candidateNodes.find((c) => c.nodeId === p.nodeId);
        if (!cn) continue;
        cn.steadyCpu += s.cpu * p.replicas;
        cn.steadyMemory += s.memory * p.replicas;
        cn.maxSurgeCpu = Math.max(cn.maxSurgeCpu, s.cpu * Math.min(s.rollout.maxSurge, p.replicas));
        cn.maxSurgeMemory = Math.max(cn.maxSurgeMemory, s.memory * Math.min(s.rollout.maxSurge, p.replicas));
      }
    }
    // Auto-add app nodes when the current pool can't fit the services (instead of erroring
    // "reduce cpu/memory/replicas"). Bounded by the total cluster-placed replica count (you
    // never need more app nodes than replicas); disabled by --no-create / --restart / --image.
    // Added nodes are provisioned for real below (sized to their placement), spend-gated by
    // the same confirmation panel as any provision.
    const maxAdd = autoAddEnabled ? clusterInputs.reduce((n, s) => n + s.replicas, 0) : 0;
    const { plans, added } = planClusterPlacementAutoAdd(
      {
        clusterId: aws.clusterId,
        clusterDefaultEdge,
        nodes: candidateNodes,
        services: clusterInputs,
      },
      { maxAdd, existingNodeIds: [...new Set([...nodes.keys(), ...clusterAppNodeIds])] },
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
      resolved.set(plan.service, {
        placements: plan.placements,
        pool: plan.pool,
        edge: plan.edge,
        domain: domains.get(plan.service),
        schedule: plan.schedule,
        topology: plan.topology,
        pinned: false,
      });
    }
  }

  const appNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const r of resolved.values()) {
    for (const n of r.pool) appNodeIds.add(n);
    if (r.edge) edgeIds.add(r.edge);
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

  // What each referenced node needs placed on it — so a missing node can be
  // auto-sized to fit, and its role inferred (edge vs co-located vs private app).
  const demandByNode = new Map<string, { cpu: number; memory: number; surgeCpu: number; surgeMemory: number }>();
  const coLocatedWebNodes = new Set<string>();
  const frontingEdgesByNode = new Map<string, Set<string>>();
  for (const s of services) {
    const r = resolved.get(s.name) as Resolved;
    const isWeb = s.domain !== undefined && s.port !== undefined;
    for (const p of r.placements) {
      const d = demandByNode.get(p.nodeId) ?? { cpu: 0, memory: 0, surgeCpu: 0, surgeMemory: 0 };
      d.cpu += s.cpu * p.replicas;
      d.memory += s.memory * p.replicas;
      // Largest single surge wins (one service rolls at a time), per resource.
      const surge = Math.min(s.rollout.maxSurge, p.replicas);
      d.surgeCpu = Math.max(d.surgeCpu, s.cpu * surge);
      d.surgeMemory = Math.max(d.surgeMemory, s.memory * surge);
      demandByNode.set(p.nodeId, d);
      if (r.edge) {
        const set = frontingEdgesByNode.get(p.nodeId) ?? new Set<string>();
        set.add(r.edge);
        frontingEdgesByNode.set(p.nodeId, set);
      } else if (isWeb) {
        coLocatedWebNodes.add(p.nodeId);
      }
    }
  }

  const demands: NodeDemand[] = [...new Set([...appNodeIds, ...edgeIds])].map((nodeId) => {
    const d = demandByNode.get(nodeId) ?? { cpu: 0, memory: 0, surgeCpu: 0, surgeMemory: 0 };
    return {
      nodeId,
      isEdgeRef: edgeIds.has(nodeId),
      isAppTarget: appNodeIds.has(nodeId),
      coLocatedWeb: coLocatedWebNodes.has(nodeId),
      frontingEdges: [...(frontingEdgesByNode.get(nodeId) ?? [])],
      cpu: d.cpu,
      memory: d.memory,
      surgeCpu: d.surgeCpu,
      surgeMemory: d.surgeMemory,
    };
  });

  // Partition referenced nodes into ready / resume (paused) / create (missing).
  const plan = await buildProvisionPlan({
    demands,
    load: async (id) => {
      const cached = nodes.get(id);
      if (cached) return cached;
      const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
      return obj ? parseNodeRegistryEntry(obj.raw) : null;
    },
    allowCreate: opts.create !== false,
  });
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
      { hint: "run `launch-pad node reconcile`, or drop --no-repair to auto-repair on deploy" },
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
    const costNodes = provisionCostNodes(toCreate, repairs);
    const costEstimate = estimateProvisionCost(costNodes);

    if (!isJsonMode()) {
      panel(opts.dryRun ? "Provisioning plan (dry run — nothing changed)" : "Provisioning plan", [
        ...toCreate.map(
          (a) =>
            `${color.green("+ create")} ${color.cyan(a.nodeId)} ${color.dim(`${a.role} · ${a.instanceType}`)}`,
        ),
        ...repairs.map((r) => repairLine(r.entry, r.drift)),
        color.dim(
          "EC2 instances are billed hourly — point each web domain's DNS at its edge (or co-located node) Elastic IP.",
        ),
      ]);
      panel("Estimated monthly cost", formatProvisionCostLines(costEstimate, aws.region));
    }

    if (opts.dryRun) {
      for (const a of toCreate) nodes.set(a.nodeId, synthesizeEntry(aws, a));
    } else {
      if (bootsInstances > 0 && opts.yes !== true) {
        const ok = await confirm(
          `provision/repair ${toCreate.length + repairs.length} node(s)? ${formatProvisionCostSummary(costEstimate)}. ` +
            "A recreate boots a fresh instance (brief downtime).",
          false,
        );
        if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
      }

      // Resolve the AMI + VPC once for the whole batch.
      const needsAmi = toCreate.length > 0 || repairs.some((r) => r.drift.action.kind === "recreate");
      const ami = needsAmi
        ? await resolveNodeAmi({
            ec2: aws.ec2,
            ssm: aws.ssm,
            region: aws.region,
            explicitAmiId: opts.ami,
          })
        : undefined;
      const amiId = toCreate.length > 0 ? ami?.imageId : undefined;
      const vpcId = toCreate.length > 0 ? await getDefaultVpcId(aws.ec2) : undefined;
      const agentVersion = readVersion();
      const agentType = requestedAgentType ?? defaultAgentTypeForBootstrap(ami?.bootstrapMode);

      // Edges/both first — an app node's security group references its edge's SG,
      // and ingress must exist before app replicas health-check.
      const createOrder = [...toCreate].sort(
        (x, y) => (x.role === "app" ? 1 : 0) - (y.role === "app" ? 1 : 0),
      );
      for (const a of createOrder) {
        const spin = spinner(`provisioning ${a.nodeId} (${a.instanceType})…`).start();
        try {
          const entry = await provisionNode({
            aws,
            nodeId: a.nodeId,
            role: a.role,
            instanceType: a.instanceType,
            agentVersion,
            capacity: a.capacity,
            amiId,
            amiBootstrapMode: ami?.bootstrapMode,
            vpcId,
            edgeNodeId: a.edgeNodeId,
            agentType,
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

      // Then drift repairs — edge/both before app, same reason.
      const repairOrder = [...repairs].sort(
        (x, y) => (x.entry.role === "app" ? 1 : 0) - (y.entry.role === "app" ? 1 : 0),
      );
      for (const r of repairOrder) {
        const verb = repairVerb(r.drift);
        const spin = spinner(`${verb.ing} ${r.entry.nodeId}…`).start();
        try {
          const updated = await applyNodeDrift({
            aws,
            entry: r.entry,
            action: r.drift.action,
            agentVersion,
            agentType: requestedAgentType,
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

  // Every referenced edge must (now) be an edge/both node.
  for (const id of edgeIds) {
    const role = nodes.get(id)?.role;
    if (role !== "edge" && role !== "both") {
      throw new CliError(`node "${id}" is referenced as an edge but its role is "${role}"`, {
        hint: `create it with: launch-pad node create ${id} --role edge --cluster ${aws.clusterId}`,
      });
    }
  }

  await assertSecretsPresent(aws, services, ownerProject);

  const allNodeIds = [...new Set([...appNodeIds, ...edgeIds])];
  // The {service → image} to reuse without building: published images for --restart, or the
  // validated override tag for --image. null for a normal (build-and-push) deploy.
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

  // Nodes this footprint occupies today but the new placement no longer targets.
  // Skipped for --service deploys: a partial deploy can't see the project's full
  // intended placement, so "vacated" would wrongly include the other services' nodes.
  const vacatedNodeIds =
    priorPlacement && !opts.service
      ? priorPlacement.occupiedNodeIds.filter((id) => !nodePlacements.has(id))
      : [];

  // Persistent volumes are only mounted by the TypeScript agent today — refuse to
  // publish a volume-bearing service to a rust-agent node, which would silently drop
  // the mount and lose the data. Checked here, before any build or write.
  for (const [id, placed] of nodePlacements) {
    assertVolumesSupported(id, nodes.get(id) as NodeRegistryEntry, placed);
  }

  // Capacity pre-flight per node BEFORE building.
  for (const [id, placed] of nodePlacements) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, id));
    const state = existing ? parseDesiredState(existing.raw) : emptyDesiredState(id, nowIso());
    assertCapacity(id, node, capacityDemands(ownerProject, state, placed));
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
    await checkDocker();
    await ensureBuilder();
    const auth = await getEcrAuth(aws.ecr);
    await dockerLoginEcr(auth);
    for (const b of built) {
      if (await imageExists(aws.ecr, b.repoName, b.tag)) {
        log.step(`${color.cyan(b.decl.name)}: image ${color.dim(b.tag)} already in ECR — skipping build`);
        continue;
      }
      const spin = spinner(`building ${b.decl.name} → ${b.tag} (linux/amd64)`).start();
      try {
        await buildAndPush({
          contextDir: b.contextDir,
          dockerfile: b.dockerfilePath,
          imageUri: b.image,
          verbose: opts.verbose,
        });
        spin.succeed(`built + pushed ${color.cyan(b.decl.name)} → ${color.dim(b.tag)}`);
      } catch (error) {
        spin.fail(`build failed for ${b.decl.name}`);
        throw error;
      }
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
    await publishDesired(aws, id, node, ownerProject, incoming);
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
    log.success(`removed ${color.cyan(ownerProject)} from ${color.cyan(id)} (no longer placed there)`);
  }

  if (!opts.dryRun) {
    await writeConfigBaseline(aws, config, ownerProject);
  }

  // Update advisory edge.json for each referenced edge.
  for (const edgeId of edgeIds) {
    const domains: string[] = [];
    for (const r of resolved.values()) {
      if (r.edge === edgeId && r.domain) domains.push(r.domain);
    }
    await publishEdgeConfig(aws, edgeId, domains);
  }

  const targets: WatchTarget[] = [];
  for (const [id, placed] of nodePlacements) {
    for (const p of placed) {
      targets.push({
        nodeId: id,
        project: ownerProject,
        service: p.built.decl.name,
        image: p.built.image,
        expectedReplicas: p.replicas,
        previousContainerIds: previousContainers.get(`${id}/${p.built.decl.name}`),
      });
    }
  }

  // A-record targets for the post-deploy DNS checklist: each web domain → the
  // Elastic IP of the node that fronts it (its edge, or its co-located node).
  const dnsTargets: DnsTarget[] = [];
  const seenDnsDomains = new Set<string>();
  for (const b of built) {
    if (!b.domain || seenDnsDomains.has(b.domain)) continue;
    seenDnsDomains.add(b.domain);
    const r = resolved.get(b.decl.name) as Resolved;
    const frontingNode = r.edge ?? r.placements[0]?.nodeId ?? null;
    if (!frontingNode) continue;
    dnsTargets.push({
      domain: b.domain,
      frontingNode,
      viaEdge: r.edge !== null,
      eip: nodes.get(frontingNode)?.publicIp ?? null,
    });
  }

  // One deploy-history event per successful publish: what ran, where it landed, and
  // (when waited) whether it converged. `kind` records the path the deploy took.
  const deployKind: DeployKind = opts.image !== undefined ? "image" : opts.restart === true ? "restart" : "build";
  const eventServices = built.map((b) => ({
    service: b.decl.name,
    image: b.image,
    replicas: (resolved.get(b.decl.name) as Resolved).placements.reduce((n, p) => n + p.replicas, 0),
  }));

  if (opts.wait === false) {
    reportPublished(built, ownerProject, placementPlan, dnsTargets);
    await recordDeployEvent(aws, { ownerProject, env, kind: deployKind, services: eventServices, converged: null });
    return;
  }
  const converged = await watchAndReport(aws, targets, resolveTimeoutMs(opts.timeout), built, placementPlan, dnsTargets);
  await recordDeployEvent(aws, { ownerProject, env, kind: deployKind, services: eventServices, converged });
}

/**
 * Parse the --timeout flag (seconds) to milliseconds. A bare `Number()` here would
 * turn a typo like `--timeout abc` into NaN, which `waitForConvergence` reads as an
 * instantly-elapsed deadline — a deploy that "times out" the moment it starts with
 * no explanation. Validate to a positive integer instead (mirrors --tail/--interval).
 */
function resolveTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONVERGE_TIMEOUT_SECONDS * 1000;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, { hint: "pass whole seconds ≥ 1, e.g. --timeout 180" });
  }
  return seconds * 1000;
}

function reportPublished(
  built: BuiltService[],
  project: string,
  placementPlan: PlacementPlanEntry[],
  dnsTargets: DnsTarget[],
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
  const dnsLines = buildDnsChecklist(dnsTargets);
  if (dnsLines.length > 0) panel("DNS — point your domains here", dnsLines);
}

async function watchAndReport(
  aws: AwsEnv,
  targets: WatchTarget[],
  timeoutMs: number,
  built: BuiltService[],
  placementPlan: PlacementPlanEntry[],
  dnsTargets: DnsTarget[],
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
    const dnsLines = buildDnsChecklist(dnsTargets);
    if (dnsLines.length > 0) panel("DNS — point your domains here", dnsLines);
  }

  if (!allConverged) {
    process.exitCode = 1;
    log.dim("not all services converged — check `launch-pad status` or the node's agent logs");
  }
  return allConverged;
}

export function registerDeploy(program: Command): void {
  const cmd = program
    .command("deploy")
    .description("Build, push, and publish your services' desired state to their nodes")
    .option("--service <name>", "deploy only this service (default: every service in launch-pad.toml)")
    .option("--node <nodeId>", "override the target node for all services")
    .option("--env <name>", "deploy as a named environment: projects each domain + namespaces the footprint")
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
    .option("--dry-run", "do everything except push images, write state, or create nodes")
    .option("--ami <id>", "AMI id for auto-provisioned/recreated nodes")
    .option("--agent <runtime>", "agent runtime for auto-provisioned nodes (default: rust on golden AMI, ts on full bootstrap)")
    .option("--restart", "skip build/push and roll containers (picks up secret/env changes)")
    .option(
      "--image <uri>",
      "skip build/push and redeploy an existing ECR tag of one --service (rollback / promote)",
    )
    .addHelpText(
      "after",
      [
        "",
        "Missing nodes (and a referenced edge) are auto-provisioned, and paused nodes",
        "resumed, after a confirmation prompt — pass --yes in CI, or --no-create to opt out.",
        "",
        "Before publishing, deploy reconciles each node's EC2 reality against the registry:",
        "a console-stopped node is started, a console-started node is synced, and a",
        "terminated instances are recreated under the same node id (edge/both keep their Elastic IP). Use --no-repair",
        "to fail on drift, or --no-recreate to allow only resume/sync.",
        "",
        "Cluster auto-placement: omit node/nodes on a [[service]] and deploy picks its",
        "nodes from the cluster. `schedule = \"even\" | \"capacity\"` chooses round-robin",
        "vs bin-packing by free CPU/memory; `topology = \"split\" | \"co-located\" | \"auto\"`",
        "chooses a dedicated edge vs one both-role node with local Caddy. Both fields are",
        "locked after the first deploy. The resolved placement map prints on every deploy.",
        "",
        "Config lock: after a project's first deploy, only cpu, memory, replicas, env, and",
        "secrets may change in launch-pad.toml. Identity/placement edits (rename, domain,",
        "port, node, edge, healthCheck, rollout, …) abort deploy before the build — there is",
        "no bypass flag. Use `launch-pad scale <field>` and `launch-pad config set` to make the",
        "allowed edits from the CLI. (When iterating on this lock locally, run the workspace",
        "CLI — `pnpm --filter @agentsystemlabs/launch-pad dev -- deploy`.)",
        "",
        "Examples:",
        "  $ launch-pad deploy",
        "  $ launch-pad deploy --service web --no-wait",
        "  $ launch-pad deploy --env staging          # parallel env on the shared edge",
        "  $ launch-pad deploy --env dev --node dev-app  # pin the env to its own node",
        "  $ launch-pad deploy --yes        # auto-provision without prompting",
        "  $ launch-pad deploy --no-create  # error if a node is missing",
        "  $ launch-pad deploy --no-repair  # error on console-side EC2 drift",
        "  $ launch-pad deploy --service web --image <uri>  # redeploy an existing tag (rollback)",
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
