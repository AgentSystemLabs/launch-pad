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
  assertConfigLockAllowed,
  baselineFromDeployedFootprints,
  checkCapacity,
  configBaselineKey,
  containerEnvForDeploy,
  desiredKey,
  ecrRepositoryName,
  parseConfigBaseline,
  snapshotConfigBaseline,
  emptyDesiredState,
  envProject,
  LABEL_REGEX,
  mergeProjectServices,
  nodeRegistryKey,
  parseDesiredState,
  parseNodeRegistryEntry,
  resolveServiceDomain,
  sharesToVcpu,
  targetNodes,
  usesClusterPlacement,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { describeInstancesById, getDefaultVpcId } from "../aws/ec2";
import { ensureRepository, getEcrAuth, imageExists } from "../aws/ecr";
import { getJson, listNodeIds, PreconditionFailedError, putJson } from "../aws/s3-state";
import { resolveLatestAl2023Ami } from "../aws/ssm";
import { getClusterConfig } from "../cluster/store";
import { loadConfig } from "../config/load";
import { rememberClusterTarget } from "../config/local";
import { buildAndPush, checkDocker, computeImageTag, dockerLoginEcr, ensureBuilder } from "../deploy/build";
import { applyNodeDrift } from "../deploy/drift-apply";
import { type NodeDrift, planNodeDrift } from "../deploy/drift-plan";
import { loadDeployedFootprints } from "../deploy/deployed-footprint";
import { distributeReplicas } from "../deploy/placement";
import {
  estimateProvisionCost,
  formatProvisionCostLines,
  formatProvisionCostSummary,
  type NodeCostInput,
} from "../cost/estimate";
import { buildProvisionPlan, type NodeAction, type NodeDemand } from "../deploy/provision-plan";
import { waitForConvergence, type WatchResult, type WatchTarget } from "../deploy/watch";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import type { AgentType } from "../provision/agent-bundle";
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

interface DeployOptions extends GlobalOpts {
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
  /** Agent runtime to install on auto-provisioned nodes: "ts" (default) or "rust". */
  agent?: string;
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

function toServiceConfig(
  project: string,
  b: BuiltService,
  replicas: number,
  resolvedEdge: string | null,
  env: string | undefined,
): ServiceConfig {
  return {
    project,
    service: b.decl.name,
    image: b.image,
    cpu: b.decl.cpu,
    memory: b.decl.memory,
    replicas,
    env: containerEnvForDeploy(b.decl.env, env),
    ingress:
      b.domain !== undefined && b.decl.port !== undefined
        ? { domain: b.domain, port: b.decl.port, edge: resolvedEdge }
        : null,
    healthCheck: b.decl.healthCheck
      ? { ...b.decl.healthCheck, port: b.decl.healthCheck.port ?? b.decl.port }
      : null,
    rollout: b.decl.rollout,
  };
}

/**
 * cpu/memory demands (multiplied by replicas) of an existing service set, plus the
 * transient surge a rolling update of that service adds: `min(maxSurge, replicas)`
 * extra replicas run simultaneously during the roll (the agent caps total at
 * `replicas + maxSurge` but never exceeds `replicas` *new* ones at once).
 */
function demandsOf(services: ServiceConfig[]): CapacityServiceDemand[] {
  return services.map((s) => {
    const surge = Math.min(s.rollout.maxSurge, s.replicas);
    return {
      project: s.project,
      service: s.service,
      cpu: s.cpu * s.replicas,
      memory: s.memory * s.replicas,
      surgeCpu: s.cpu * surge,
      surgeMemory: s.memory * surge,
    };
  });
}

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
async function publishDesired(
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
async function publishEdgeConfig(aws: AwsEnv, edgeId: string, domains: string[]): Promise<void> {
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
    hint: "only cpu and memory may change after the initial deploy — revert the other edits",
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
 * Reject any launch-pad.toml change except cpu/memory after the first deploy.
 * Runs BEFORE any build / ECR push / S3 write, so a locked-field change aborts
 * deploy immediately. There is no bypass flag.
 */
export async function enforceConfigLock(
  aws: AwsEnv,
  config: LaunchPadConfig,
  ownerProject: string,
  opts: DeployOptions,
): Promise<void> {
  const deployed = await loadLockBaseline(aws, ownerProject);
  if (!deployed) {
    log.dim(`config lock: no prior deploy for ${color.cyan(ownerProject)} — recording a baseline after this deploy`);
    return;
  }
  log.step(`config lock: comparing launch-pad.toml against ${deployed.source}`);

  if (opts.node) {
    throw new CliError(`--node cannot be used after the initial deploy of "${ownerProject}"`, {
      hint: "placement is locked — only cpu and memory may change; drop --node",
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

async function runDeploy(opts: DeployOptions): Promise<void> {
  const { config, dir } = loadConfig();

  if (opts.agent !== undefined && opts.agent !== "ts" && opts.agent !== "rust") {
    throw new CliError(`invalid --agent "${opts.agent}" (expected ts | rust)`);
  }
  const agentType: AgentType = opts.agent === "rust" ? "rust" : "ts";

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
    services = services.map((s) => ({ ...s, node: opts.node as string, nodes: undefined }));
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

  await enforceConfigLock(aws, config, ownerProject, opts);

  // Resolve the cluster's default edge + (when any service targets the cluster) its app nodes.
  const clusterCfg = aws.clusterId === DEFAULT_CLUSTER ? null : await getClusterConfig(aws, aws.clusterId);
  const clusterDefaultEdge = clusterCfg?.defaultEdge ?? null;
  const nodes = new Map<string, NodeRegistryEntry>();
  const clusterAppNodeIds: string[] = [];
  if (services.some((s) => usesClusterPlacement(s))) {
    for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
      const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
      if (!obj) continue;
      const entry = parseNodeRegistryEntry(obj.raw);
      nodes.set(id, entry);
      if (entry.role === "app" || entry.role === "both") clusterAppNodeIds.push(id);
    }
    if (clusterAppNodeIds.length === 0) {
      throw new CliError(`cluster "${aws.clusterId}" has no app nodes to place services on`, {
        hint: `create one: launch-pad node create <name> --cluster ${aws.clusterId} --role app`,
      });
    }
  }

  // Per service, resolve its target node ids + the edge that fronts it.
  interface Resolved {
    nodeIds: string[];
    edge: string | null;
    domain?: string;
  }
  const resolved = new Map<string, Resolved>();
  const appNodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const s of services) {
    const nodeIds = usesClusterPlacement(s) ? [...clusterAppNodeIds] : targetNodes(s);
    const isWeb = s.domain !== undefined && s.port !== undefined;
    const edge = isWeb ? (s.edge ?? clusterDefaultEdge) : null;
    if (isWeb && nodeIds.length > 1 && !edge) {
      throw new CliError(`service "${s.name}" spans ${nodeIds.length} nodes but has no edge to load-balance them`, {
        hint: usesClusterPlacement(s)
          ? `set the cluster's edge: launch-pad cluster set-edge ${aws.clusterId} <edge-node-id>`
          : `add edge = "<edge-node-id>" to the service`,
      });
    }
    const domain = resolveServiceDomain(
      { domain: s.domain, domainPattern: s.domainPattern ?? config.domainPattern, service: s.name },
      env,
    );
    resolved.set(s.name, { nodeIds, edge, domain });
    for (const n of nodeIds) appNodeIds.add(n);
    if (edge) edgeIds.add(edge);
    if (s.edge && nodeIds.length === 1 && nodeIds[0] === s.edge) {
      log.warn(
        `service "${s.name}": edge and node are both "${s.edge}" — co-located mode; omit edge for the same result`,
      );
    }
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
    for (const p of distributeReplicas(r.nodeIds, s.replicas)) {
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
      const amiId = toCreate.length > 0 ? await resolveLatestAl2023Ami(aws.ssm) : undefined;
      const vpcId = toCreate.length > 0 ? await getDefaultVpcId(aws.ec2) : undefined;
      const agentVersion = readVersion();

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

  // Ensure ECR repos + immutable tags (one image per service, regardless of replicas).
  const built: BuiltService[] = [];
  for (const decl of services) {
    // ECR repo + image tag stay keyed on the BASE project so an env reuses prod's image.
    const repoName = ecrRepositoryName(config.project, decl.name);
    const repoUri = await ensureRepository(aws.ecr, repoName, {
      project: config.project,
      service: decl.name,
    });
    const contextDir = resolve(dir, decl.context);
    const tag = await computeImageTag(contextDir);
    built.push({
      decl,
      repoName,
      repoUri,
      tag,
      image: `${repoUri}:${tag}`,
      contextDir,
      dockerfilePath: resolve(dir, decl.dockerfile),
      domain: resolved.get(decl.name)?.domain,
    });
  }

  // Distribute replicas across each service's resolved nodes.
  const nodePlacements = new Map<string, NodeService[]>();
  for (const b of built) {
    const r = resolved.get(b.decl.name) as Resolved;
    for (const p of distributeReplicas(r.nodeIds, b.decl.replicas)) {
      const list = nodePlacements.get(p.nodeId) ?? [];
      list.push({ built: b, replicas: p.replicas });
      nodePlacements.set(p.nodeId, list);
    }
  }

  // Capacity pre-flight per node BEFORE building.
  for (const [id, placed] of nodePlacements) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, id));
    const state = existing ? parseDesiredState(existing.raw) : emptyDesiredState(id, nowIso());
    assertCapacity(id, node, capacityDemands(ownerProject, state, placed));
    printCapacitySummary(id, node, placed);
  }

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
      });
    }
    return;
  }

  // Build + push each image once.
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

  // Publish desired state per node.
  for (const [id, placed] of nodePlacements) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const incoming = placed.map((p) =>
      toServiceConfig(ownerProject, p.built, p.replicas, (resolved.get(p.built.decl.name) as Resolved).edge, env),
    );
    await publishDesired(aws, id, node, ownerProject, incoming);
    log.success(`published desired state → ${color.cyan(id)}`);
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
      });
    }
  }

  if (opts.wait === false) {
    reportPublished(built, ownerProject);
    return;
  }
  await watchAndReport(aws, targets, resolveTimeoutMs(opts.timeout), built);
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

function reportPublished(built: BuiltService[], project: string): void {
  if (isJsonMode()) {
    printJson({
      published: true,
      project,
      services: built.map((b) => ({ service: b.decl.name, image: b.image })),
    });
    return;
  }
  panel("Published", [
    ...built.map((b) => `${color.cyan(`${project}/${b.decl.name}`)} ${color.dim(`×${b.decl.replicas}`)}`),
    color.dim("the agent on each node will reconcile to this state"),
  ]);
}

async function watchAndReport(
  aws: AwsEnv,
  targets: WatchTarget[],
  timeoutMs: number,
  built: BuiltService[],
): Promise<void> {
  const spin = spinner("waiting for nodes to converge…").start();
  let final: WatchResult[] = [];
  await waitForConvergence(aws.s3, aws.bucket, aws.clusterId, targets, timeoutMs, (results) => {
    final = results;
    const running = results.filter((r) => r.ok).length;
    spin.text = `converging ${running}/${results.length} services…`;
  });

  if (final.every((r) => r.ok)) {
    spin.succeed("all services running");
  } else {
    spin.stop();
  }

  if (isJsonMode()) {
    printJson({
      converged: final.every((r) => r.ok),
      services: final.map((r) => ({ ...r.target, state: r.state, ok: r.ok, message: r.message })),
    });
    if (!final.every((r) => r.ok)) process.exitCode = 1;
    return;
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
  }

  if (!final.every((r) => r.ok)) {
    process.exitCode = 1;
    log.dim("not all services converged — check `launch-pad status` or the node's agent logs");
  }
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
    .option("--agent <runtime>", "agent runtime for auto-provisioned nodes: ts (default) or rust", "ts")
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
        "Config lock: after a project's first deploy, only cpu and memory may change in",
        "launch-pad.toml. Any other edit (rename, domain, env, node, replicas, …) aborts",
        "deploy before the build — there is no bypass flag. (When iterating on this lock",
        "locally, run the workspace CLI — `pnpm --filter @agentsystemlabs/launch-pad dev",
        "-- deploy` — the published npm package may predate it.)",
        "",
        "Examples:",
        "  $ launch-pad deploy",
        "  $ launch-pad deploy --service web --no-wait",
        "  $ launch-pad deploy --env staging          # parallel env on the shared edge",
        "  $ launch-pad deploy --env dev --node dev-app  # pin the env to its own node",
        "  $ launch-pad deploy --yes        # auto-provision without prompting",
        "  $ launch-pad deploy --no-create  # error if a node is missing",
        "  $ launch-pad deploy --no-repair  # error on console-side EC2 drift",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runDeploy(mergedOpts<DeployOptions>(command));
    });

  applyGlobalOptions(cmd);
}
