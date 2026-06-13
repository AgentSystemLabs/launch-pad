import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  agentIdForNode,
  type CapacityServiceDemand,
  checkCapacity,
  DEFAULT_CLUSTER,
  desiredKey,
  footprintOwner,
  generateNodeNames,
  HEARTBEAT_STALE_MS,
  type InstanceCapacity,
  isHeartbeatStale,
  LABEL_REGEX,
  type NodeRegistryEntry,
  nodeFrontsIngress,
  nodePrefix,
  nodeRegistryKey,
  nodeUsesElasticIp,
  ProvisionNodeRoleSchema,
  parseDesiredState,
  parseNodeRegistryEntry,
  parseNodeStatus,
  sharesToVcpu,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import {
  deleteSecurityGroup,
  describeInstancesById,
  type Ec2Observation,
  getDefaultVpcId,
  releaseEip,
  stopInstance,
  terminateInstance,
} from "../../aws/ec2";
import { awsErrorName, isDestroyAlreadyGoneError } from "../../aws/errors";
import { deleteNodeIam, nodeProfileName, nodeRoleName } from "../../aws/iam";
import { getClusterConfig, putClusterConfig } from "../../cluster/store";
import { rememberClusterTarget } from "../../config/local";
import { deletePrefix, ensureBucket, getJson, listNodeIds, putJson } from "../../aws/s3-state";
import { applyNodeDrift } from "../../deploy/drift-apply";
import { type NodeDrift, planNodeDrift } from "../../deploy/drift-plan";
import { findConfigPath, loadConfig } from "../../config/load";
import { CliError, EvacuationBlockedError } from "../../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../../globals";
import { provisionRoleOf, resolveNodeAmi, resolveNodeAmiByRole } from "../../provision/golden-ami";
import { installLoggingOnNode } from "../../provision/install-logging";
import { parseCreateAmount, planNodeCreateNames } from "./create-names";
import { planEdgeForAppNode } from "./resolve-edge";
import { registerMonitor } from "./monitor";
import { type ResizeEvacuationPlan, planResizeEvacuation } from "./resize-evacuate";
import { type RebalanceOptions, runRebalance } from "../rebalance";
import {
  provisionNode,
  resizeNode,
  resolveCapacity,
  resumeNode,
  securityGroupName,
} from "../../provision/provision-node";
import { manualUpgradeHint, upgradeAgentOnNode } from "../../provision/upgrade-agent";
import { renderUserData } from "../../provision/user-data";
import { panel, table } from "../../ui/box";
import { isJsonMode, log, printJson, spinner } from "../../ui/log";
import { confirm } from "../../ui/prompt";
import { color, symbols } from "../../ui/theme";
import { assertValidNodeId } from "../../validate-node-id";
import { readVersion } from "../../version";

async function loadNode(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
  if (!obj) {
    throw new CliError(`node "${nodeId}" does not exist in cluster "${aws.clusterId}"`, {
      hint: "list nodes with `launchpad node list`",
    });
  }
  return parseNodeRegistryEntry(obj.raw);
}

/** Every edge-role node id registered in the cluster (S3-lexicographic order). */
async function listEdgeRoleNodeIds(aws: AwsEnv): Promise<string[]> {
  const ids: string[] = [];
  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (obj && nodeFrontsIngress(parseNodeRegistryEntry(obj.raw).role)) ids.push(id);
  }
  return ids;
}

/** Human label for a node's live EC2 state. */
function ec2StateLabel(obs: Ec2Observation): string {
  switch (obs.kind) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "transitional":
      return obs.state;
    case "missing":
      return "missing";
  }
}

/** A colored badge when registry intent and EC2 reality disagree, else null. */
function driftBadge(drift: NodeDrift["drift"]): string | null {
  switch (drift) {
    case "none":
      return null;
    case "stopped":
      return color.yellow("DRIFT — stopped in EC2 (registry expects it up)");
    case "running":
      return color.yellow("DRIFT — running in EC2 (registry says paused)");
    case "gone":
      return color.red("DRIFT — instance is gone");
    case "transitional":
      return color.dim("EC2 not stable yet");
  }
}

// ── create ─────────────────────────────────────────────────────────────────────

interface CreateOptions extends GlobalOpts {
  instanceType: string;
  role: string;
  edge?: string;
  keyName?: string;
  ami?: string;
  agentVersion?: string;
  amount?: string | number;
  yes?: boolean;
  dryRun?: boolean;
}

async function runCreate(baseName: string | undefined, opts: CreateOptions): Promise<void> {
  if (baseName !== undefined) assertValidNodeId(baseName);
  const amount = parseCreateAmount(opts.amount);
  if (opts.edge !== undefined) assertValidNodeId(opts.edge);
  const aws = await prepareAws(opts);
  // No name given → generate `<noun>-<verb>-<adverb>` id(s), unique against the
  // cluster's existing nodes. An explicit base name keeps the sequential behavior.
  const names =
    baseName !== undefined
      ? planNodeCreateNames(baseName, amount)
      : generateNodeNames(amount, await listNodeIds(aws.s3, aws.bucket, aws.clusterId));
  const agentVersion = opts.agentVersion ?? readVersion();

  const roleResult = ProvisionNodeRoleSchema.safeParse(opts.role);
  if (!roleResult.success) {
    throw new CliError(`invalid --role "${opts.role}" (expected app | edge)`);
  }
  const role = roleResult.data;

  const capacity = await resolveCapacity(aws, opts.instanceType);
  const ami = await resolveNodeAmi({
    ec2: aws.ec2,
    ssm: aws.ssm,
    region: aws.region,
    role,
    explicitAmiId: opts.ami,
  });
  const amiId = ami.imageId;
  const vpcId = await getDefaultVpcId(aws.ec2);

  if (opts.dryRun) {
    const dryPlans: unknown[] = [];
    for (const name of names) {
      const needsDownload = ami.bootstrapMode === "full";
      const userData = renderUserData({
        agent: {
          nodeId: name,
          agentId: agentIdForNode(name),
          bucket: aws.bucket,
          region: aws.region,
          clusterId: aws.clusterId,
          role,
        },
        agentBinaryUrl: needsDownload
          ? "https://<state-bucket>.../agent?<presigned-at-launch>"
          : undefined,
        bootstrapMode: ami.bootstrapMode,
      });
      if (isJsonMode()) {
        dryPlans.push({
          dryRun: true,
          node: name,
          cluster: aws.clusterId,
          region: aws.region,
          instanceType: opts.instanceType,
          capacity,
          amiId,
          amiSource: ami.source,
          amiBootstrapMode: ami.bootstrapMode,
          vpcId,
          securityGroup: securityGroupName(name),
          iamRole: nodeRoleName(aws.clusterId, name),
          instanceProfile: nodeProfileName(aws.clusterId, name),
          ssh: opts.keyName !== undefined,
          userData,
        });
      } else {
        printDryRun(name, opts, aws, capacity, amiId, ami.source, ami.bootstrapMode, vpcId, userData);
      }
    }
    if (isJsonMode()) {
      printJson(amount === 1 ? dryPlans[0] : dryPlans);
    }
    return;
  }

  // Cost gate: launching an instance is billable + hard to undo.
  if (opts.yes !== true) {
    const nodeLabel =
      names.length === 1
        ? `"${names[0]}"`
        : `${names.length} nodes (${names.map((n) => color.cyan(n)).join(", ")})`;
    const ok = await confirm(
      `launch ${names.length === 1 ? "a" : names.length} ${color.cyan(opts.instanceType)} EC2 instance${names.length === 1 ? "" : "s"} in ${color.cyan(aws.region)} (billed hourly) and register ${nodeLabel}?`,
      false,
    );
    if (!ok) {
      throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
    }
  }

  await ensureBucket(aws.s3, aws.bucket, aws.region, aws.clusterId);
  // Record the cluster's AWS target locally so the `cluster` commands can find a
  // cluster created implicitly via `--cluster` (S3 stays authoritative for existence).
  rememberClusterTarget(aws.clusterId, { region: aws.region, profile: opts.profile });

  for (const name of names) {
    const existing = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, name));
    if (existing) {
      throw new CliError(`node "${name}" already exists in cluster "${aws.clusterId}"`, {
        hint: "pick another name or `launchpad node destroy` it first",
      });
    }
  }

  // Resolve the edge for an app node: explicit --edge → cluster default →
  // the cluster's single edge-role node. The user shouldn't have to name an
  // edge the cluster already defines (see planEdgeForAppNode). Only hit S3 for
  // the cluster's edge when no explicit --edge short-circuits the lookup.
  let edgeNodeId: string | undefined;
  if (role === "app") {
    const needsLookup = !opts.edge;
    edgeNodeId = planEdgeForAppNode({
      clusterId: aws.clusterId,
      explicitEdge: opts.edge,
      defaultEdge: needsLookup ? (await getClusterConfig(aws, aws.clusterId))?.defaultEdge : undefined,
      edgeRoleNodeIds: needsLookup ? await listEdgeRoleNodeIds(aws) : [],
    });
  }

  const created: NodeRegistryEntry[] = [];
  for (const name of names) {
    const spin = spinner(`provisioning ${color.cyan(name)}…`).start();
    try {
      const entry = await provisionNode({
        aws,
        nodeId: name,
        role,
        instanceType: opts.instanceType,
        agentVersion,
        capacity,
        amiId,
        amiBootstrapMode: ami.bootstrapMode,
        vpcId,
        edgeNodeId,
        keyName: opts.keyName,
        onProgress: (t) => {
          spin.text = t;
        },
      });
      if (spin.isSpinning) spin.succeed(`launched node ${color.cyan(name)} (${entry.instanceId})`);
      created.push(entry);
      if (!isJsonMode()) reportCreated(entry);
    } catch (error) {
      if (spin.isSpinning) spin.fail(`provisioning ${name} failed`);
      throw error;
    }
  }

  if (isJsonMode()) {
    printJson(amount === 1 ? created[0] : created);
  }
}

function reportCreated(entry: NodeRegistryEntry): void {
  if (isJsonMode()) {
    printJson(entry);
    return;
  }
  const createdRows: Array<[string, string]> = [
    ["instance", entry.instanceId ?? color.yellow("pending")],
    ["cluster", entry.clusterId],
    ["instance type", entry.instanceType],
    ["region / az", `${entry.region} ${color.dim(entry.availabilityZone ?? "")}`],
  ];
  if (entry.role === "app") {
    createdRows.push(["network", color.dim("VPC-private (no public IP)")]);
  } else {
    createdRows.push(["elastic ip", entry.publicIp ?? color.yellow("pending")]);
  }
  createdRows.push(["capacity", `${sharesToVcpu(entry.totalCpu)} vCPU · ${entry.totalMemory} MB`]);
  panel(`Node ${entry.nodeId}`, [
    ...table(createdRows),
    "",
    color.dim("the agent installs on boot and reconciles desired state from S3."),
    ...(entry.role === "app"
      ? [color.dim("reachable only by its edge over the VPC — point DNS at the edge's Elastic IP.")]
      : entry.publicIp
        ? [
            `${color.dim("for web services, point your domain's A record at")} ${color.cyan(entry.publicIp)}`,
            color.dim("this Elastic IP is stable — it survives `node pause` / `node resume`."),
          ]
        : []),
  ]);
}

function printDryRun(
  name: string,
  opts: CreateOptions,
  aws: AwsEnv,
  capacity: InstanceCapacity,
  amiId: string,
  amiSource: string,
  amiBootstrapMode: string,
  vpcId: string,
  userData: string,
): void {
  if (isJsonMode()) {
    printJson({
      dryRun: true,
      node: name,
      cluster: aws.clusterId,
      region: aws.region,
      instanceType: opts.instanceType,
      capacity,
      amiId,
      amiSource,
      amiBootstrapMode,
      vpcId,
      securityGroup: securityGroupName(name),
      iamRole: nodeRoleName(aws.clusterId, name),
      instanceProfile: nodeProfileName(aws.clusterId, name),
      ssh: opts.keyName !== undefined,
      userData,
    });
    return;
  }
  const sshNote = opts.keyName ? " + 22" : "";
  const sgRule =
    opts.role === "app"
      ? `host ports ${color.dim(`(from edge ${opts.edge ?? "?"} only)`)}`
      : `80/443${sshNote}`;
  const planRows: Array<[string, string]> = [
    ["cluster", aws.clusterId],
    ["region", aws.region],
    ["role", opts.role],
  ];
  if (opts.role === "app") planRows.push(["public ip", color.dim("none (VPC-private)")]);
  planRows.push(["instance type", `${opts.instanceType} ${color.dim(`(${sharesToVcpu(capacity.totalCpu)} vCPU · ${capacity.totalMemory} MB)`)}`]);
  planRows.push(["ami", `${amiId} ${color.dim(`(${amiSource}, ${amiBootstrapMode} bootstrap)`)}`]);
  planRows.push(["vpc", vpcId]);
  planRows.push(["security group", `${securityGroupName(name)} ${color.dim(`(${sgRule})`)}`]);
  planRows.push(["iam role", nodeRoleName(aws.clusterId, name)]);
  planRows.push(["instance profile", nodeProfileName(aws.clusterId, name)]);
  panel(`Plan for node ${name} ${color.dim("(dry run — nothing created)")}`, [...table(planRows)]);
  log.plain(color.dim("  ── generated bootstrap (user_data) ──"));
  for (const line of userData.split("\n")) log.dim(`  ${line}`);
  log.plain();
}

// ── list ─────────────────────────────────────────────────────────────────────

async function safeListNodeIds(aws: AwsEnv): Promise<string[]> {
  try {
    return await listNodeIds(aws.s3, aws.bucket, aws.clusterId);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
}

async function usedCapacity(aws: AwsEnv, nodeId: string): Promise<{ cpu: number; memory: number }> {
  const obj = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
  if (!obj) return { cpu: 0, memory: 0 };
  try {
    const state = parseDesiredState(obj.raw);
    return {
      cpu: state.services.reduce((s, x) => s + x.cpu, 0),
      memory: state.services.reduce((s, x) => s + x.memory, 0),
    };
  } catch {
    return { cpu: 0, memory: 0 };
  }
}

async function heartbeat(aws: AwsEnv, nodeId: string): Promise<string> {
  const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
  if (!obj) return color.dim("no agent yet");
  try {
    const status = parseNodeStatus(obj.raw);
    return isHeartbeatStale(status.lastSeen, Date.now(), HEARTBEAT_STALE_MS)
      ? color.yellow("stale")
      : color.green("live");
  } catch {
    return color.dim("—");
  }
}

async function runList(opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const ids = await safeListNodeIds(aws);

  type ListItem =
    | { kind: "ok"; node: NodeRegistryEntry }
    | { kind: "broken"; nodeId: string }
    | { kind: "missing-registry"; nodeId: string };

  const items: ListItem[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) {
      items.push({ kind: "missing-registry", nodeId: id });
      continue;
    }
    try {
      items.push({ kind: "ok", node: parseNodeRegistryEntry(obj.raw) });
    } catch {
      items.push({ kind: "broken", nodeId: id });
    }
  }

  const entries = items.flatMap((item) => (item.kind === "ok" ? [item.node] : []));

  // One batch DescribeInstances surfaces live EC2 state + drift for every node.
  let obsMap = new Map<string, Ec2Observation>();
  try {
    obsMap = await describeInstancesById(
      aws.ec2,
      entries.flatMap((e) => (e.instanceId ? [e.instanceId] : [])),
    );
  } catch {
    /* no EC2 visibility — fall back to registry-only display */
  }
  const observe = (e: NodeRegistryEntry): Ec2Observation | null =>
    e.instanceId ? (obsMap.get(e.instanceId) ?? { kind: "missing" }) : null;
  const driftOf = (e: NodeRegistryEntry): NodeDrift["drift"] => {
    const obs = observe(e);
    return obs ? planNodeDrift(e, obs, { allowRecreate: true }).drift : "none";
  };

  if (isJsonMode()) {
    printJson(
      items.map((item) => {
        if (item.kind === "missing-registry") {
          return { nodeId: item.nodeId, status: "missing-registry" };
        }
        if (item.kind === "broken") {
          return { nodeId: item.nodeId, status: "broken" };
        }
        const obs = observe(item.node);
        return {
          ...item.node,
          ec2State: obs ? ec2StateLabel(obs) : null,
          drift: driftOf(item.node),
        };
      }),
    );
    return;
  }
  if (items.length === 0) {
    log.info("no nodes registered yet");
    log.dim("  create one with `launchpad node create <name>`");
    return;
  }

  log.plain();
  for (const item of items) {
    if (item.kind === "missing-registry") {
      log.plain(
        `  ${color.cyan(item.nodeId)}  ${color.red("missing node.json")}  ${color.dim("(prefix exists in S3 but no registry entry)")}`,
      );
      continue;
    }
    if (item.kind === "broken") {
      log.plain(
        `  ${color.cyan(item.nodeId)}  ${color.red("BROKEN")}  ${color.dim("node.json failed to parse")}`,
      );
      continue;
    }
    const node = item.node;
    const used = await usedCapacity(aws, node.nodeId);
    const beat = await heartbeat(aws, node.nodeId);
    const obs = observe(node);
    const where = node.instanceId
      ? `${color.dim(node.instanceId)} ${node.publicIp ?? ""}`.trim()
      : color.yellow("not provisioned");
    const badge = driftBadge(driftOf(node));
    const legacyBadge = node.role === "both" ? color.yellow("legacy both") : null;
    log.plain(
      `  ${color.cyan(node.nodeId)}  ${color.dim(`${node.role} · ${node.instanceType}`)}  ${beat}  ${where}${legacyBadge ? `  ${legacyBadge}` : ""}${badge ? `  ${badge}` : ""}`,
    );
    log.plain(
      `    ${color.dim(
        `cpu ${sharesToVcpu(used.cpu)}/${sharesToVcpu(node.totalCpu - node.reservedCpu)} vCPU · ` +
          `mem ${used.memory}/${node.totalMemory - node.reservedMemory} MB · ${node.region}` +
          (obs ? ` · ec2 ${ec2StateLabel(obs)}` : ""),
      )}`,
    );
  }
  log.plain();
}

// ── show ─────────────────────────────────────────────────────────────────────

async function runShow(name: string, opts: GlobalOpts): Promise<void> {
  assertValidNodeId(name);
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);

  // Observe live EC2 reality (read-only) to surface drift vs. the registry.
  let obs: Ec2Observation | null = null;
  if (node.instanceId) {
    try {
      obs =
        (await describeInstancesById(aws.ec2, [node.instanceId])).get(node.instanceId) ?? {
          kind: "missing",
        };
    } catch {
      obs = null; // no EC2 visibility (e.g. restricted creds) — show the registry only
    }
  }
  const publicIp = obs?.kind === "running" ? (obs.publicIp ?? node.publicIp) : node.publicIp;
  const drift = obs ? planNodeDrift(node, obs, { allowRecreate: true }).drift : "none";

  const desired = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, name));
  const status = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, name));

  if (isJsonMode()) {
    printJson({
      node: { ...node, publicIp },
      ec2: obs ? { state: ec2StateLabel(obs), drift } : null,
      desired: desired?.raw ?? null,
      status: status?.raw ?? null,
    });
    return;
  }

  const rows: Array<[string, string]> = [
    ["instance", node.instanceId ?? color.yellow("not provisioned")],
    ["cluster", node.clusterId],
    ["role", node.role],
    ["instance type", node.instanceType],
    ["private ip", node.privateIp ?? color.dim("—")],
    ["region / az", `${node.region} ${color.dim(node.availabilityZone ?? "")}`],
    [
      "public ip",
      nodeUsesElasticIp(node.role) ? (publicIp ?? color.dim("—")) : color.dim("none (VPC-private)"),
    ],
    ["security group", node.securityGroupId ?? color.dim("—")],
    ["capacity", `${sharesToVcpu(node.totalCpu)} vCPU · ${node.totalMemory} MB`],
    ["registry state", node.state],
  ];
  if (obs) rows.push(["ec2 state", ec2StateLabel(obs)]);
  rows.push(["created", `${node.createdAt} ${color.dim(`by ${node.createdBy}`)}`]);

  const badge = driftBadge(drift);
  panel(`Node ${name}`, [...table(rows), ...(badge ? ["", badge] : [])]);

  let services: Array<{ project: string; service: string; image: string }> = [];
  if (desired) {
    try {
      services = parseDesiredState(desired.raw).services.map((s) => ({
        project: s.project,
        service: s.service,
        image: s.image,
      }));
    } catch {
      /* ignore malformed */
    }
  }
  if (services.length === 0) {
    log.dim("  no services scheduled on this node");
  } else {
    panel(
      "Desired services",
      services.map((s) => `${color.cyan(`${s.project}/${s.service}`)} ${color.dim(s.image)}`),
    );
  }
}

// ── destroy ────────────────────────────────────────────────────────────────────

interface DestroyOptions extends GlobalOpts {
  yes?: boolean;
  /** Destroy even when the node still hosts services (they will be orphaned). */
  force?: boolean;
  /**
   * Before destroying, auto-evacuate the current project's cluster-placed services off the
   * node(s) (= `node evacuate` / `rebalance --drain`) and wait for them to come up elsewhere.
   */
  evacuate?: boolean;
  /** Target a named environment footprint for --evacuate (same as deploy --env). */
  env?: string;
  /** Seconds to wait for the evacuation to converge before tearing the node down. */
  timeout?: string;
}

/** A (project, service) pair scheduled on a node — what `node destroy` would orphan. */
export interface ScheduledService {
  project: string;
  service: string;
}

export interface OrphanRisk {
  name: string;
  services: ScheduledService[];
}

/**
 * The nodes that still host services — destroying them orphans those services
 * (their containers keep running with no desired-state owner). Pure so the
 * refuse-without-`--force` decision is unit-tested.
 */
export function nodesThatWouldOrphan(
  targets: Array<{ name: string; services: ScheduledService[] }>,
): OrphanRisk[] {
  return targets
    .filter((t) => t.services.length > 0)
    .map((t) => ({ name: t.name, services: t.services }));
}

export interface EvacuationAssessment {
  /** Target nodes that host at least one movable service — pass these as the drain set. */
  drainNodes: string[];
  /**
   * Per target node, the services auto-evacuate can NOT move: a service whose volumes
   * live on the node (data is node-local) or any other project's service
   * (`node destroy --evacuate` only moves the current project's services). If any
   * remain, destroy still needs `--force`.
   */
  unmovable: OrphanRisk[];
}

/**
 * Split a destroy target's hosted services into movable vs. unmovable for `--evacuate`.
 * A service is movable iff it belongs to `ownerProject` AND is volume-less (its name is
 * in `movableNames` — volume data is node-local and can't move). Pure so the
 * evacuate-vs-refuse decision is unit-tested without S3/AWS.
 */
export function assessEvacuation(
  targets: Array<{ name: string; services: ScheduledService[] }>,
  ownerProject: string,
  movableNames: Set<string>,
): EvacuationAssessment {
  const drainNodes: string[] = [];
  const unmovable: OrphanRisk[] = [];
  for (const t of targets) {
    const isMovable = (s: ScheduledService): boolean =>
      s.project === ownerProject && movableNames.has(s.service);
    if (t.services.some(isMovable)) drainNodes.push(t.name);
    const stuck = t.services.filter((s) => !isMovable(s));
    if (stuck.length > 0) unmovable.push({ name: t.name, services: stuck });
  }
  return { drainNodes, unmovable };
}

/** Split node id arguments into unique, trimmed names (comma- or space-delimited). */
export function parseNodeNames(args: string | string[]): string[] {
  const parts = (Array.isArray(args) ? args : [args]).flatMap((arg) =>
    arg.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  if (parts.length === 0) {
    throw new CliError("no node names provided", {
      hint: "pass one or more node ids, e.g. `node destroy app-1,app-2` or `node destroy app-1 app-2`",
    });
  }
  const names = [...new Set(parts)];
  for (const name of names) assertValidNodeId(name);
  return names;
}

async function listScheduledServices(aws: AwsEnv, name: string): Promise<ScheduledService[]> {
  const desired = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, name));
  if (!desired) return [];
  try {
    return parseDesiredState(desired.raw).services.map((s) => ({ project: s.project, service: s.service }));
  } catch {
    return [];
  }
}

interface TeardownProgress {
  text?: (message: string) => void;
  warn?: (message: string) => void;
}

interface DestroyTarget {
  name: string;
  node: NodeRegistryEntry | null;
  services: ScheduledService[];
}

async function loadDestroyTarget(aws: AwsEnv, name: string): Promise<DestroyTarget> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, name));
  if (!obj) {
    return { name, node: null, services: [] };
  }
  let node: NodeRegistryEntry;
  try {
    node = parseNodeRegistryEntry(obj.raw);
  } catch {
    throw new CliError(`node "${name}" registry entry is malformed`, {
      hint: "fix or delete the object in S3 manually, then retry",
    });
  }
  return { name, node, services: await listScheduledServices(aws, name) };
}

async function tryDestroyStep(
  progress: TeardownProgress | undefined,
  label: string,
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (isDestroyAlreadyGoneError(error)) return;
    progress?.warn?.(`${label}: ${(error as Error).message}`);
  }
}

export async function teardownNode(
  aws: AwsEnv,
  node: NodeRegistryEntry,
  progress?: TeardownProgress,
): Promise<void> {
  const name = node.nodeId;
  if (node.instanceId) {
    progress?.text?.(`terminating ${node.instanceId}`);
    await tryDestroyStep(progress, `terminate ${node.instanceId}`, () =>
      terminateInstance(aws.ec2, node.instanceId!),
    );
  }
  if (node.eipAllocationId) {
    progress?.text?.("releasing Elastic IP");
    await tryDestroyStep(progress, `release Elastic IP ${node.eipAllocationId}`, () =>
      releaseEip(aws.ec2, node.eipAllocationId!),
    );
  }
  if (node.securityGroupId) {
    progress?.text?.("deleting security group");
    await tryDestroyStep(progress, `delete security group ${node.securityGroupId}`, () =>
      deleteSecurityGroup(aws.ec2, node.securityGroupId!),
    );
  }
  // Delete the node's per-node IAM role + instance profile (best-effort + idempotent;
  // only ever touches `launch-pad-node-<cluster>-<node>`-named resources, so a legacy
  // shared role is left alone). Matches `cluster destroy` — without this, single-node
  // destroy left orphan IAM roles/profiles accumulating in the account.
  progress?.text?.("deleting IAM role");
  await tryDestroyStep(progress, `delete IAM role ${nodeRoleName(node.clusterId, name)}`, () =>
    deleteNodeIam(aws.iam, node.clusterId, name),
  );
  // If this node was its cluster's default edge, clear that pointer first.
  if (node.clusterId !== DEFAULT_CLUSTER) {
    await tryDestroyStep(progress, "clear default edge", async () => {
      const cc = await getClusterConfig(aws, node.clusterId);
      if (cc?.defaultEdge === name) {
        await putClusterConfig(aws, { ...cc, defaultEdge: null });
      }
    });
  }

  progress?.text?.("removing node state");
  const prefix = nodePrefix(node.clusterId, name);
  await tryDestroyStep(progress, `delete s3://${aws.bucket}/${prefix}`, () =>
    deletePrefix(aws.s3, aws.bucket, prefix),
  );
}

/** Sweep leftover S3 objects when a node prefix exists but node.json is gone. */
async function sweepOrphanNodePrefix(aws: AwsEnv, nodeId: string): Promise<number> {
  try {
    return await deletePrefix(aws.s3, aws.bucket, nodePrefix(aws.clusterId, nodeId));
  } catch {
    return 0;
  }
}

async function runDestroy(namesArg: string | string[], opts: DestroyOptions): Promise<void> {
  const names = parseNodeNames(namesArg);
  const aws = await prepareAws(opts);

  const targets = await Promise.all(names.map((name) => loadDestroyTarget(aws, name)));
  const active = targets.filter((t): t is DestroyTarget & { node: NodeRegistryEntry } => t.node !== null);
  const alreadyGone = targets.filter((t) => t.node === null).map((t) => t.name);

  if (active.length === 0) {
    const swept = await Promise.all(
      alreadyGone.map(async (name) => ({ name, removed: await sweepOrphanNodePrefix(aws, name) })),
    );
    const cleaned = swept.filter((s) => s.removed > 0);
    if (isJsonMode()) {
      printJson({
        destroyed: [],
        alreadyDestroyed: names.length === 1 ? names[0] : names,
        ...(cleaned.length > 0
          ? { sweptOrphans: cleaned.map((s) => ({ nodeId: s.name, objects: s.removed })) }
          : {}),
      });
      return;
    }
    if (cleaned.length > 0) {
      log.success(
        `removed orphaned state for ${cleaned.length} node(s): ${cleaned.map((s) => color.cyan(s.name)).join(", ")}`,
      );
      return;
    }
    const label = names.length === 1 ? `node ${color.cyan(names[0]!)}` : `${names.length} nodes`;
    log.info(`${label} already destroyed`);
    return;
  }

  if (alreadyGone.length > 0 && !isJsonMode()) {
    log.dim(`  skipping already-destroyed: ${alreadyGone.map((n) => color.cyan(n)).join(", ")}`);
  }

  // --evacuate: before the orphan gate, auto-move the current project's cluster-placed
  // services off the doomed node(s) and wait for them to come up elsewhere. After this the
  // re-read services drive the gate below — so a node cleanly evacuated proceeds, while one
  // still hosting volume-bearing/other-project services is caught by the gate.
  let orphaning = nodesThatWouldOrphan(active);
  let evacuation: EvacuateRun | null = null;
  if (orphaning.length > 0 && opts.evacuate === true) {
    evacuation = await autoEvacuate(aws, active, opts);
    orphaning = nodesThatWouldOrphan(active);
  }

  // Safety gate: destroying a node still hosting services orphans them (their
  // containers keep running with no desired-state owner, and no node reconciles
  // them). Refuse unless --force explicitly acknowledges the orphaning.
  if (orphaning.length > 0 && opts.force !== true) {
    const lines = orphaning.map(
      (o) => `  ${color.cyan(o.name)}: ${o.services.map((s) => `${s.project}/${s.service}`).join(", ")}`,
    );
    const hint = opts.evacuate === true
      ? "auto-evacuate only moves THIS project's services — volume-bearing or other-project services remain; evacuate those projects too, or pass --force to orphan them"
      : "evacuate them first (`node evacuate` / `node destroy --evacuate`), or pass --force to destroy and orphan them anyway";
    throw new CliError(
      `refusing to destroy — ${orphaning.length} node(s) still host services that would be orphaned:\n${lines.join("\n")}`,
      { hint },
    );
  }

  if (opts.yes !== true) {
    const totalServices = active.reduce((sum, t) => sum + t.services.length, 0);
    if (totalServices > 0) {
      const msg =
        active.length === 1
          ? `node "${active[0]!.name}" still has ${totalServices} scheduled service(s) — they will be orphaned (--force)`
          : `${active.length} node(s) still have ${totalServices} scheduled service(s) combined — they will be orphaned (--force)`;
      log.warn(msg);
    }
    const what =
      active.length === 1
        ? active[0]!.node.instanceId
          ? `terminate instance ${active[0]!.node.instanceId} and destroy`
          : "destroy"
        : `terminate and destroy ${active.length} nodes`;
    const label =
      active.length === 1
        ? `node "${active[0]!.name}"`
        : active.map((t) => `"${t.name}"`).join(", ");
    const ok = await confirm(`${what} ${label}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  let destroyed: string[];
  if (active.length === 1) {
    const target = active[0]!;
    const spin = spinner("tearing down…").start();
    await teardownNode(aws, target.node, {
      text: (t) => {
        spin.text = t;
      },
      warn: (t) => {
        spin.warn(t);
        spin.start();
      },
    });
    destroyed = [target.name];
    if (spin.isSpinning) spin.succeed(`destroyed node ${color.cyan(target.name)}`);
  } else {
    const spin = spinner(`destroying ${active.length} nodes…`).start();
    await Promise.all(active.map((target) => teardownNode(aws, target.node)));
    destroyed = active.map((t) => t.name);
    if (spin.isSpinning) {
      spin.succeed(
        `destroyed ${destroyed.length} nodes: ${destroyed.map((n) => color.cyan(n)).join(", ")}`,
      );
    }
  }

  const sweptOrphans =
    alreadyGone.length > 0
      ? (await Promise.all(
          alreadyGone.map(async (name) => ({ name, removed: await sweepOrphanNodePrefix(aws, name) })),
        )).filter((s) => s.removed > 0)
      : [];

  if (!isJsonMode() && sweptOrphans.length > 0) {
    log.dim(
      `  removed orphaned state: ${sweptOrphans.map((s) => color.cyan(s.name)).join(", ")}`,
    );
  }

  if (isJsonMode()) {
    const payload: {
      destroyed: string | string[];
      alreadyDestroyed?: string | string[];
      sweptOrphans?: Array<{ nodeId: string; objects: number }>;
      evacuated?: { project: string; nodes: string[] };
    } = {
      destroyed: destroyed.length === 1 ? destroyed[0]! : destroyed,
    };
    if (alreadyGone.length > 0) {
      payload.alreadyDestroyed = alreadyGone.length === 1 ? alreadyGone[0]! : alreadyGone;
    }
    if (sweptOrphans.length > 0) {
      payload.sweptOrphans = sweptOrphans.map((s) => ({ nodeId: s.name, objects: s.removed }));
    }
    if (evacuation && evacuation.drainNodes.length > 0) {
      payload.evacuated = { project: evacuation.project, nodes: evacuation.drainNodes };
    }
    printJson(payload);
  }
}

async function runPrune(opts: GlobalOpts & { yes?: boolean }): Promise<void> {
  const aws = await prepareAws(opts);
  const ids = await safeListNodeIds(aws);
  const orphans: string[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) orphans.push(id);
  }

  if (orphans.length === 0) {
    if (isJsonMode()) {
      printJson({ pruned: [] });
      return;
    }
    log.info("no orphaned node prefixes");
    return;
  }

  if (opts.yes !== true) {
    const ok = await confirm(
      `remove orphaned S3 state for ${orphans.length} node(s) (${orphans.map((n) => `"${n}"`).join(", ")})?`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const pruned: Array<{ nodeId: string; objects: number }> = [];
  for (const id of orphans) {
    const removed = await sweepOrphanNodePrefix(aws, id);
    if (removed > 0) pruned.push({ nodeId: id, objects: removed });
  }

  if (isJsonMode()) {
    printJson({ pruned });
    return;
  }
  if (pruned.length === 0) {
    log.info("no orphaned node prefixes");
    return;
  }
  log.success(
    `pruned ${pruned.length} orphaned node prefix(es): ${pruned.map((p) => color.cyan(p.nodeId)).join(", ")}`,
  );
}

interface EvacuateRun {
  project: string;
  /** Nodes drained (those that hosted the project's cluster-placed services). */
  drainNodes: string[];
  /** True if the evacuation couldn't move everything (volume-bearing / last app node). */
  blocked: boolean;
}

/**
 * Move the current project's cluster-placed services off the doomed node(s) before the
 * destroy tears them down. Reads launch-pad.toml from CWD, reuses `rebalance --drain` over the
 * whole drain set at once (so a replica never lands on a sibling that's also going away), waits
 * for the surviving pool to converge, then re-reads each target's scheduled services so the
 * caller's orphan gate sees the post-evacuation state. Returns null when this project has
 * nothing movable on any target (the gate then refuses with the unmovable services).
 */
async function autoEvacuate(
  aws: AwsEnv,
  active: Array<DestroyTarget & { node: NodeRegistryEntry }>,
  opts: DestroyOptions,
): Promise<EvacuateRun | null> {
  if (!findConfigPath(process.cwd())) {
    throw new CliError("--evacuate needs your project's launch-pad.toml to know what to move", {
      hint: "run from your project directory, or omit --evacuate and pass --force to orphan the services",
    });
  }
  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const { config } = loadConfig();
  const ownerProject = footprintOwner(config, opts.env);
  const movableNames = new Set(
    config.service.filter((s) => s.volumes.length === 0).map((s) => s.name),
  );

  const assessment = assessEvacuation(active, ownerProject, movableNames);
  if (assessment.drainNodes.length === 0) return null; // nothing this project can move

  if (!isJsonMode()) {
    log.step(
      `evacuating ${color.cyan(ownerProject)} off ${assessment.drainNodes
        .map((n) => color.cyan(n))
        .join(", ")} before destroy…`,
    );
  }

  let blocked = false;
  try {
    await runRebalance({
      ...pickGlobalOpts(opts),
      env: opts.env,
      drainNodes: assessment.drainNodes,
      yes: true,
      wait: true,
      quiet: true,
      timeout: parseEvacuateTimeout(opts.timeout),
    });
  } catch (error) {
    if (error instanceof EvacuationBlockedError) {
      // Pinned service on a target, or draining everything would leave no app nodes —
      // nothing moved. Fall through to the orphan gate (which refuses unless --force).
      blocked = true;
      if (!isJsonMode()) log.dim(`  could not fully auto-evacuate: ${error.message}`);
    } else {
      throw error; // config-lock drift, convergence timeout, AWS error — abort before any teardown
    }
  }

  // Re-read each target's scheduled services so the orphan gate sees the published result.
  for (const t of active) t.services = await listScheduledServices(aws, t.name);
  return { project: ownerProject, drainNodes: assessment.drainNodes, blocked };
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

/** Parse `--timeout <seconds>` to a positive integer (seconds), or undefined for the default. */
function parseEvacuateTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new CliError(`invalid --timeout "${raw}"`, { hint: "pass whole seconds ≥ 1, e.g. --timeout 300" });
  }
  return seconds;
}

// ── pause / resume (save money) ──────────────────────────────────────────────────

async function runPause(name: string, opts: GlobalOpts): Promise<void> {
  assertValidNodeId(name);
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);
  if (!node.instanceId) {
    throw new CliError(`node "${name}" has no instance to pause`);
  }

  const spin = spinner(`pausing ${name} (stopping ${node.instanceId})…`).start();
  try {
    await stopInstance(aws.ec2, node.instanceId);
    await putJson(aws.s3, aws.bucket, nodeRegistryKey(node.clusterId, name), { ...node, state: "stopped" });
    spin.succeed(`paused node ${color.cyan(name)}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("pause failed");
    throw error;
  }

  if (isJsonMode()) {
    printJson({ paused: name });
    return;
  }
  log.dim(
    nodeUsesElasticIp(node.role)
      ? "  compute billing stops; the Elastic IP + EBS volume still incur a small charge"
      : "  compute billing stops; the EBS volume still incurs a small charge",
  );
  log.dim(`  resume with: ${color.cyan(`launchpad node resume ${name}`)}`);
}

async function runResume(name: string, opts: GlobalOpts): Promise<void> {
  assertValidNodeId(name);
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);
  if (!node.instanceId) {
    throw new CliError(`node "${name}" has no instance to resume`);
  }

  const spin = spinner(`resuming ${name} (starting ${node.instanceId})…`).start();
  try {
    const updated = await resumeNode(aws, node);
    const addr = nodeUsesElasticIp(updated.role)
      ? (updated.publicIp ?? "?")
      : (updated.privateIp ?? "?");
    const label = nodeUsesElasticIp(updated.role) ? "public ip" : "private ip";
    spin.succeed(`resumed node ${color.cyan(name)} at ${label} ${addr}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("resume failed");
    throw error;
  }

  if (isJsonMode()) {
    printJson({ resumed: name });
    return;
  }
  if (nodeUsesElasticIp(node.role) && !node.eipAllocationId) {
    log.warn("this node has no Elastic IP, so its public IP may have changed — re-check `node show`");
  }
}

// ── resize (change instance type) ─────────────────────────────────────────────────

interface ResizeOptions extends GlobalOpts {
  instanceType?: string;
  yes?: boolean;
  dryRun?: boolean;
  /**
   * Non-disruptive resize: evacuate the current project's cluster-placed services off the
   * node (= `rebalance --drain --wait`), resize the emptied instance, then rebalance back.
   */
  evacuate?: boolean;
  /** Target a named environment footprint for --evacuate (same as deploy --env). */
  env?: string;
  /** Seconds --evacuate waits for each convergence (drain, then rebalance-back). */
  timeout?: string;
}

/** Full capacity demand (incl. rollout surge) of every service scheduled on a node. */
async function scheduledDemands(aws: AwsEnv, nodeId: string): Promise<CapacityServiceDemand[]> {
  const obj = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
  if (!obj) return [];
  let state: ReturnType<typeof parseDesiredState>;
  try {
    state = parseDesiredState(obj.raw);
  } catch {
    return [];
  }
  return state.services.map((s) => {
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

/**
 * Resolve what `--evacuate` can do for this resize (pure decision in
 * {@link planResizeEvacuation}) and refuse the impossible cases up front — a paused node
 * (nothing running, and the rebalance-back would wait on a stopped agent) and a node this
 * project keeps persistent volumes on (`rebalance --drain` hard-blocks on volume-bearing services).
 */
async function assessResizeEvacuation(
  aws: AwsEnv,
  name: string,
  node: NodeRegistryEntry,
  opts: ResizeOptions,
): Promise<{ plan: ResizeEvacuationPlan; ownerProject: string }> {
  if (!findConfigPath(process.cwd())) {
    throw new CliError("--evacuate needs your project's launch-pad.toml to know what to move", {
      hint: "run from your project directory, or omit --evacuate to resize with brief downtime",
    });
  }
  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const { config } = loadConfig();
  const ownerProject = footprintOwner(config, opts.env);
  const movableNames = new Set(
    config.service.filter((s) => s.volumes.length === 0).map((s) => s.name),
  );
  const plan = planResizeEvacuation({
    nodeState: node.state,
    services: await listScheduledServices(aws, name),
    ownerProject,
    clusterPlacedNames: movableNames,
  });
  if (plan.kind === "refuse-stopped") {
    throw new CliError(`node "${name}" is paused — there is nothing running to evacuate`, {
      hint: "a paused node resizes in place with no downtime; re-run without --evacuate",
    });
  }
  if (plan.kind === "refuse-pinned") {
    throw new CliError(
      `can't evacuate "${name}": ${plan.pinned.map((s) => `${s.project}/${s.service}`).join(", ")} keep persistent volumes on it`,
      { hint: "re-run without --evacuate to accept the brief downtime for the volume-bearing service(s)" },
    );
  }
  return { plan, ownerProject };
}

/**
 * Best-effort: after the drain is published (and the replicas are confirmed running
 * elsewhere), wait for the drained node's agent to report the footprint's services gone —
 * so containers get a graceful agent-driven stop (and an app node retracts its upstream
 * shard) instead of being killed by the instance stop. A timeout proceeds with a warning
 * rather than failing: the replicas are already up elsewhere, only graceful shutdown is
 * at stake.
 */
async function waitForNodeDrained(
  aws: AwsEnv,
  nodeId: string,
  ownerProject: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
    if (obj) {
      try {
        const status = parseNodeStatus(obj.raw);
        const mine = status.services.filter((s) => s.project === ownerProject);
        if (mine.every((s) => s.runningReplicas === 0)) return true;
      } catch {
        /* malformed status — keep polling */
      }
    }
    if (Date.now() > deadline) return false;
    await sleep(3000);
  }
}

async function runResize(name: string, opts: ResizeOptions): Promise<void> {
  assertValidNodeId(name);
  const instanceType = opts.instanceType;
  if (!instanceType) {
    throw new CliError("--instance-type is required", {
      hint: `e.g. launchpad node resize ${name} --instance-type t3.large`,
    });
  }
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);
  if (!node.instanceId) {
    throw new CliError(`node "${name}" has no instance to resize`, {
      hint: "provision it first with `launchpad node create`",
    });
  }
  if (node.instanceType === instanceType) {
    throw new CliError(`node "${name}" is already a ${instanceType}`);
  }

  const capacity = await resolveCapacity(aws, instanceType);

  // Guard a shrink: the services already scheduled on this node (plus a rolling
  // update's surge) must still fit the target instance.
  const check = checkCapacity({
    totalCpu: capacity.totalCpu,
    totalMemory: capacity.totalMemory,
    reservedCpu: node.reservedCpu,
    reservedMemory: node.reservedMemory,
    services: await scheduledDemands(aws, name),
  });
  if (!check.ok) {
    const over: string[] = [];
    if (check.cpuOverBy > 0) over.push(`${sharesToVcpu(check.cpuOverBy)} vCPU`);
    if (check.memoryOverBy > 0) over.push(`${check.memoryOverBy} MB`);
    throw new CliError(
      `${instanceType} is too small for node "${name}" — its scheduled services exceed it by ${over.join(" and ")}`,
      { hint: "pick a larger type, or reduce cpu/memory/replicas (or move services off) first" },
    );
  }

  // --evacuate: decide what can move BEFORE the dry-run/prompt so both tell the truth,
  // and refuse the cases where a non-disruptive resize is impossible up front.
  const evac = opts.evacuate === true ? await assessResizeEvacuation(aws, name, node, opts) : null;
  const evacPlan = evac?.plan ?? null;
  const draining = evacPlan?.kind === "drain";

  const summaryRows: Array<[string, string]> = [
    [
      "from",
      `${node.instanceType} ${color.dim(`(${sharesToVcpu(node.totalCpu)} vCPU · ${node.totalMemory} MB)`)}`,
    ],
    [
      "to",
      `${instanceType} ${color.dim(`(${sharesToVcpu(capacity.totalCpu)} vCPU · ${capacity.totalMemory} MB)`)}`,
    ],
  ];
  if (evacPlan) {
    summaryRows.push([
      "evacuate",
      draining
        ? "drain cluster-placed services → resize → rebalance back"
        : "nothing this project can move — plain resize",
    ]);
  }

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({
        dryRun: true,
        node: name,
        from: { instanceType: node.instanceType, totalCpu: node.totalCpu, totalMemory: node.totalMemory },
        to: { instanceType, totalCpu: capacity.totalCpu, totalMemory: capacity.totalMemory },
        ...(evacPlan ? { evacuate: draining } : {}),
      });
    } else {
      panel(`Resize node ${name} ${color.dim("(dry run — nothing changed)")}`, [...table(summaryRows)]);
    }
    return;
  }

  if (opts.yes !== true && !isJsonMode()) {
    panel(`Resize node ${name}`, [...table(summaryRows)]);
    const ok = await confirm(
      draining
        ? `resize "${name}" to ${color.cyan(instanceType)}? its cluster-placed services move off first and rebalance back after.`
        : `resize "${name}" to ${color.cyan(instanceType)}? the instance stops and starts — its services are briefly down.`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  // Drain: move the footprint's cluster-placed services elsewhere and WAIT for them to be
  // confirmed running before the instance stops — that's the non-disruptive part.
  if (draining) {
    if (evacPlan.ridesDowntime.length > 0) {
      log.warn(
        `can't move ${evacPlan.ridesDowntime.map((s) => `${s.project}/${s.service}`).join(", ")} (other projects) — they ride the brief stop/start`,
      );
    }
    if (!isJsonMode()) log.step(`evacuating ${color.cyan(name)} before the resize…`);
    try {
      await runRebalance({
        ...pickGlobalOpts(opts),
        env: opts.env,
        drain: name,
        yes: true,
        wait: true,
        quiet: true,
        timeout: parseEvacuateTimeout(opts.timeout),
      });
    } catch (error) {
      if (error instanceof EvacuationBlockedError) {
        throw new CliError(`can't evacuate "${name}" for a non-disruptive resize: ${error.message}`, {
          hint: "add an app node first, or re-run without --evacuate to accept the brief downtime",
        });
      }
      throw error; // config-lock drift, convergence timeout, AWS error — abort before any downtime
    }

    // Give the drained node's agent one poll to stop its containers gracefully (and an
    // app node to retract its upstream shard) before the instance is stopped under them.
    const drainedCleanly = await waitForNodeDrained(
      aws,
      name,
      evac!.ownerProject, // draining ⇒ evac is set
      (parseEvacuateTimeout(opts.timeout) ?? 300) * 1000,
    );
    if (!drainedCleanly) {
      log.warn(`${name}'s agent hasn't confirmed the drain — its old containers stop with the instance`);
    }
  }

  // Re-read the registry entry after the (potentially long) drain so the final
  // registry write doesn't clobber a concurrent edit made in the meantime.
  const freshNode = draining ? await loadNode(aws, name) : node;

  const spin = spinner(`resizing ${name}…`).start();
  let updated: NodeRegistryEntry;
  try {
    updated = await resizeNode({
      aws,
      node: freshNode,
      instanceType,
      capacity,
      onProgress: (t) => {
        spin.text = t;
      },
    });
    spin.succeed(`resized node ${color.cyan(name)} to ${color.cyan(instanceType)}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("resize failed");
    if (draining) {
      // The footprint was already evacuated; point the operator at the recovery path
      // (e.g. a failed start after the retype leaves the instance stopped).
      throw new CliError(`resize failed after "${name}" was evacuated: ${(error as Error).message}`, {
        hint: `the services are running on the other node(s) — if the instance is stopped, \`launchpad node resume ${name}\` (or retry the resize), then \`launchpad rebalance\` to restore the spread`,
      });
    }
    throw error;
  }

  // Rebalance back: re-plan over the full pool (the resized node included) and wait for
  // convergence, so the command returns with the footprint settled at the new size. The
  // booted agent reconciles desired state on its next poll; `wait` blocks on that.
  if (draining) {
    if (!isJsonMode()) log.step(`rebalancing services back onto ${color.cyan(name)}…`);
    try {
      await runRebalance({
        ...pickGlobalOpts(opts),
        env: opts.env,
        yes: true,
        wait: true,
        quiet: true,
        timeout: parseEvacuateTimeout(opts.timeout),
      });
    } catch (error) {
      // The resize itself succeeded — don't let a slow rebalance-back read as a failed
      // resize (re-running the resize would repeat the disruptive stop/start for nothing).
      throw new CliError(
        `node "${name}" was resized to ${instanceType}, but the rebalance back hasn't finished: ${(error as Error).message}`,
        { hint: "the resize is done — watch `launchpad status` and re-run `launchpad rebalance` (NOT the resize) to restore the spread" },
      );
    }
  }

  if (isJsonMode()) {
    printJson({
      resized: name,
      instanceType: updated.instanceType,
      totalCpu: updated.totalCpu,
      totalMemory: updated.totalMemory,
      ...(opts.evacuate === true ? { evacuated: draining } : {}),
    });
    return;
  }
  if (updated.state === "stopped") {
    log.dim(
      `  node was paused — it stays stopped at the new size; resume with: ${color.cyan(`launchpad node resume ${name}`)}`,
    );
  } else if (nodeUsesElasticIp(node.role) && !node.eipAllocationId) {
    log.warn("this node has no Elastic IP, so its public IP may have changed — re-check `node show`");
  } else if (node.role === "app") {
    log.dim("  the agent re-publishes routing on boot — the edge picks up any new private IP automatically");
  }
}

// ── upgrade-agent ───────────────────────────────────────────────────────────────

interface UpgradeAgentOptions extends GlobalOpts {
  yes?: boolean;
  dryRun?: boolean;
  uploadOnly?: boolean;
  agentVersion?: string;
}

async function runUpgradeAgent(name: string | undefined, opts: UpgradeAgentOptions): Promise<void> {
  if (name !== undefined) assertValidNodeId(name);
  const aws = await prepareAws(opts);
  const agentVersion = opts.agentVersion ?? readVersion();

  const ids = name ? [name] : await safeListNodeIds(aws);
  const entries: NodeRegistryEntry[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) {
      if (name) {
        throw new CliError(`node "${id}" does not exist in cluster "${aws.clusterId}"`, {
          hint: "list nodes with `launchpad node list`",
        });
      }
      continue;
    }
    try {
      entries.push(parseNodeRegistryEntry(obj.raw));
    } catch {
      /* skip malformed */
    }
  }

  const targets = entries.filter((e) => e.instanceId);
  if (targets.length === 0) {
    throw new CliError("no nodes with a running EC2 instance to upgrade", {
      hint: "provision a node first, or pass a specific node id",
    });
  }

  if (!isJsonMode()) {
    log.plain();
    for (const e of targets) {
      const action = opts.uploadOnly
        ? "upload agent bundle to S3"
        : "upload agent bundle + restart agent via SSM";
      log.plain(`  ${color.cyan(e.nodeId)}  ${color.dim(action)}  ${color.dim(e.instanceId ?? "")}`);
    }
    log.plain();
  }

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({
        dryRun: true,
        agentVersion,
        nodes: targets.map((e) => ({ nodeId: e.nodeId, instanceId: e.instanceId, agentType: e.agentType })),
      });
    } else {
      log.info(`dry run — would upgrade ${targets.length} node(s) to agent ${agentVersion}`);
    }
    return;
  }

  if (opts.yes !== true && !isJsonMode()) {
    const verb = opts.uploadOnly ? "upload agent bundles for" : "upgrade the agent on";
    const ok = await confirm(
      `${verb} ${targets.length} node(s)? the on-box agent restarts briefly unless you pass --upload-only.`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const results = [];
  const manualLines: string[] = [];

  // Edge/both before app — Caddy routes should pick up new agent behavior first.
  const order = [...targets].sort((a, b) => (a.role === "app" ? 1 : 0) - (b.role === "app" ? 1 : 0));

  for (const entry of order) {
    const spin = spinner(`upgrading ${entry.nodeId}…`).start();
    try {
      const result = await upgradeAgentOnNode({
        aws,
        entry,
        agentVersion,
        uploadOnly: opts.uploadOnly,
        onProgress: (t) => {
          spin.text = t;
        },
      });
      results.push(result);
      if (result.delivery === "ssm" || result.delivery === "upload-only") {
        spin.succeed(
          `${color.cyan(entry.nodeId)}  ${color.dim(result.delivery === "upload-only" ? "bundle uploaded" : "agent restarted via SSM")}`,
        );
      } else {
        spin.warn(`${color.cyan(entry.nodeId)}  ${color.yellow("bundle uploaded — install manually")}`);
        if (result.bundleUrl) manualLines.push(manualUpgradeHint(entry.nodeId, result.bundleUrl));
        if (result.error) manualLines.push(`    ${color.dim(result.error)}`);
      }
    } catch (error) {
      if (spin.isSpinning) spin.fail(`upgrade ${entry.nodeId} failed`);
      throw error;
    }
  }

  if (isJsonMode()) {
    printJson({ agentVersion, results });
    return;
  }

  if (manualLines.length > 0) {
    log.plain();
    log.warn("SSM could not reach some nodes — finish the upgrade on the instance:");
    log.plain();
    for (const line of manualLines) log.plain(line);
    log.plain();
    log.info(
      "attach AmazonSSMManagedInstanceCore to the node IAM role, wait ~2 min for SSM registration, then re-run upgrade-agent",
    );
  }
}

// ── reconcile (EC2 drift) ─────────────────────────────────────────────────────────

interface ReconcileOptions extends GlobalOpts {
  yes?: boolean;
  dryRun?: boolean;
  /** commander sets this false for `--no-recreate` (a terminated instance is replaced by default). */
  recreate?: boolean;
}

async function runReconcile(name: string | undefined, opts: ReconcileOptions): Promise<void> {
  if (name !== undefined) assertValidNodeId(name);
  const aws = await prepareAws(opts);
  const allowRecreate = opts.recreate !== false;

  // One named node, or every node in the cluster.
  const ids = name ? [name] : await safeListNodeIds(aws);
  const entries: NodeRegistryEntry[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) {
      if (name) {
        throw new CliError(`node "${id}" does not exist in cluster "${aws.clusterId}"`, {
          hint: "list nodes with `launchpad node list`",
        });
      }
      continue;
    }
    try {
      entries.push(parseNodeRegistryEntry(obj.raw));
    } catch {
      /* skip malformed entries */
    }
  }

  const withInstance = entries.filter((e) => e.instanceId);
  const obsMap = await describeInstancesById(
    aws.ec2,
    withInstance.map((e) => e.instanceId as string),
  );

  interface Item {
    entry: NodeRegistryEntry;
    obs: Ec2Observation;
    drift: NodeDrift;
  }
  const items: Item[] = withInstance.map((entry) => {
    const obs = obsMap.get(entry.instanceId as string) ?? ({ kind: "missing" } as Ec2Observation);
    return { entry, obs, drift: planNodeDrift(entry, obs, { allowRecreate }) };
  });
  const repairs = items.filter((i) => i.drift.action.kind !== "noop");

  // Human-readable summary (always, before any mutation).
  if (!isJsonMode()) {
    log.plain();
    for (const i of items) {
      const badge = driftBadge(i.drift.drift);
      log.plain(
        `  ${color.cyan(i.entry.nodeId)}  ${color.dim(`registry ${i.entry.state} · ec2 ${ec2StateLabel(i.obs)}`)}  ${badge ?? color.green("in sync")}`,
      );
    }
    log.plain();
  }

  // A transitional instance (or a gone one with --no-recreate) can't be repaired now.
  const blockedMsgs = repairs.flatMap((i) =>
    i.drift.action.kind === "blocked" ? [`${i.entry.nodeId}: ${i.drift.action.reason}`] : [],
  );
  if (blockedMsgs.length > 0) {
    throw new CliError(`can't reconcile ${blockedMsgs.length} node(s):\n  ${blockedMsgs.join("\n  ")}`, {
      hint: allowRecreate
        ? "wait for the instance to stabilize, then retry"
        : "drop --no-recreate to replace a terminated instance",
    });
  }

  const reportJson = (reconciled: string[]) => {
    if (!isJsonMode()) return;
    printJson({
      cluster: aws.clusterId,
      nodes: items.map((i) => ({
        nodeId: i.entry.nodeId,
        registryState: i.entry.state,
        ec2State: ec2StateLabel(i.obs),
        drift: i.drift.drift,
        action: i.drift.action.kind,
      })),
      reconciled,
    });
  };

  if (repairs.length === 0) {
    if (!isJsonMode()) log.success("all nodes in sync — nothing to reconcile");
    reportJson([]);
    return;
  }

  if (opts.dryRun) {
    if (!isJsonMode()) log.warn(`dry run — ${repairs.length} repair(s) would be applied`);
    reportJson([]);
    return;
  }

  const boots = repairs.some(
    (i) => i.drift.action.kind === "resume" || i.drift.action.kind === "recreate",
  );
  if (boots && opts.yes !== true) {
    const ok = await confirm(
      `apply ${repairs.length} repair(s)? a recreate boots a fresh instance (brief downtime); EC2 billed hourly.`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const agentVersion = readVersion();
  const recreateAmiByRole = await resolveNodeAmiByRole(
    { ec2: aws.ec2, ssm: aws.ssm, region: aws.region },
    repairs
      .filter((i) => i.drift.action.kind === "recreate")
      .map((i) => provisionRoleOf(i.entry.role)),
  );
  // Edge/both before app — ingress first.
  const order = [...repairs].sort(
    (x, y) => (x.entry.role === "app" ? 1 : 0) - (y.entry.role === "app" ? 1 : 0),
  );
  const reconciled: string[] = [];
  for (const i of order) {
    const spin = spinner(`reconciling ${i.entry.nodeId} (${i.drift.action.kind})…`).start();
    const recreateAmi = recreateAmiByRole.get(provisionRoleOf(i.entry.role));
    try {
      await applyNodeDrift({
        aws,
        entry: i.entry,
        action: i.drift.action,
        agentVersion,
        amiId: recreateAmi?.imageId,
        amiBootstrapMode: recreateAmi?.bootstrapMode,
        onProgress: (t) => {
          spin.text = t;
        },
      });
      reconciled.push(i.entry.nodeId);
      spin.succeed(`reconciled ${color.cyan(i.entry.nodeId)} ${color.dim(i.drift.action.kind)}`);
    } catch (error) {
      if (spin.isSpinning) spin.fail(`reconcile ${i.entry.nodeId} failed`);
      throw error;
    }
  }
  reportJson(reconciled);
}

// ── install-logging ───────────────────────────────────────────────────────────────

interface InstallLoggingOptions extends GlobalOpts {
  yes?: boolean;
  dryRun?: boolean;
}

async function runInstallLogging(name: string | undefined, opts: InstallLoggingOptions): Promise<void> {
  if (name !== undefined) assertValidNodeId(name);
  const aws = await prepareAws(opts);

  const ids = name ? [name] : await safeListNodeIds(aws);
  const entries: NodeRegistryEntry[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (!obj) {
      if (name) {
        throw new CliError(`node "${id}" does not exist in cluster "${aws.clusterId}"`, {
          hint: "list nodes with `launchpad node list`",
        });
      }
      continue;
    }
    try {
      entries.push(parseNodeRegistryEntry(obj.raw));
    } catch {
      /* skip malformed */
    }
  }

  const targets = entries.filter((e) => e.instanceId);
  if (targets.length === 0) {
    throw new CliError("no nodes with a running EC2 instance to install logging on", {
      hint: "provision a node first, or pass a specific node id",
    });
  }

  if (!isJsonMode()) {
    log.plain();
    for (const e of targets) {
      log.plain(
        `  ${color.cyan(e.nodeId)}  ${color.dim("update IAM + install CloudWatch Agent via SSM")}  ${color.dim(e.instanceId ?? "")}`,
      );
    }
    log.plain();
  }

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({ dryRun: true, nodes: targets.map((e) => ({ nodeId: e.nodeId, instanceId: e.instanceId })) });
    } else {
      log.info(`dry run — would install logging on ${targets.length} node(s)`);
    }
    return;
  }

  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(
      `install CloudWatch log shipping on ${targets.length} node(s)? this updates IAM and installs the CloudWatch Agent over SSM.`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const results = [];
  const manualNodes: string[] = [];
  // Edge/both first — ingress logs before app logs.
  const order = [...targets].sort((a, b) => (a.role === "app" ? 1 : 0) - (b.role === "app" ? 1 : 0));
  for (const entry of order) {
    const spin = spinner(`installing logging on ${entry.nodeId}…`).start();
    try {
      const result = await installLoggingOnNode({
        aws,
        entry,
        onProgress: (t) => {
          spin.text = t;
        },
      });
      results.push(result);
      if (result.delivery === "ssm") {
        spin.succeed(`${color.cyan(entry.nodeId)}  ${color.dim("CloudWatch Agent installed")}`);
      } else {
        spin.warn(`${color.cyan(entry.nodeId)}  ${color.yellow("IAM updated — SSM install failed")}`);
        manualNodes.push(`    ${color.dim(`${entry.nodeId}: ${result.error ?? "SSM unreachable"}`)}`);
      }
    } catch (error) {
      if (spin.isSpinning) spin.fail(`install logging on ${entry.nodeId} failed`);
      throw error;
    }
  }

  if (isJsonMode()) {
    printJson({ results });
    return;
  }

  if (manualNodes.length > 0) {
    log.plain();
    log.warn("SSM could not reach some nodes — attach AmazonSSMManagedInstanceCore, wait ~2 min, and re-run:");
    for (const line of manualNodes) log.plain(line);
    log.plain();
  } else {
    log.dim("  logs flow within ~1–2 minutes — read them with `launchpad logs <service>`");
  }
}

// ── registration ────────────────────────────────────────────────────────────────

export function registerNode(program: Command): void {
  const node = program
    .command("node")
    .description("Manage launchpad nodes — the machines that run your services");

  const create = node
    .command("create [name]")
    .description(
      "Provision an EC2 node, install the agent, and register it (name is generated when omitted)",
    )
    .option("--instance-type <type>", "EC2 instance type", "t3.small")
    .option("--role <role>", "node role: app | edge", "app")
    .option("--edge <nodeId>", "for an app node: the edge node that routes to it")
    .option("--key-name <keypair>", "EC2 key pair for SSH (omit to disable SSH)")
    .option("--ami <id>", "AMI id (default: launchpad golden AMI, falling back to latest Amazon Linux 2023)")
    .option("--agent-version <semver>", "agent version to install (default: this CLI's version)")
    .option(
      "--amount <n>",
      "create N nodes — generated names when [name] is omitted; sequential ids from an explicit base (app → app-1..app-N)",
      "1",
    )
    .option("--dry-run", "show the provisioning plan + bootstrap without creating anything")
    .option("--yes", "skip the launch confirmation prompt")
    .action(async (name: string | undefined, _opts, command: Command) => {
      await runCreate(name, mergedOpts<CreateOptions>(command));
    });
  applyGlobalOptions(create);

  const list = node
    .command("list")
    .description("List registered nodes and their capacity / heartbeat")
    .action(async (_opts, command: Command) => {
      await runList(mergedOpts(command));
    });
  applyGlobalOptions(list);

  const prune = node
    .command("prune")
    .description("Remove orphaned S3 node prefixes that have no node.json registry entry")
    .option("--yes", "skip confirmation prompts")
    .action(async (_opts, command: Command) => {
      await runPrune(mergedOpts<GlobalOpts & { yes?: boolean }>(command));
    });
  applyGlobalOptions(prune);

  const show = node
    .command("show <name>")
    .description("Show a node's registry entry, desired state, and status")
    .action(async (name: string, _opts, command: Command) => {
      await runShow(name, mergedOpts(command));
    });
  applyGlobalOptions(show);

  const destroy = node
    .command("destroy <names...>")
    .description(
      "Terminate node instance(s), release their IPs, and deregister them (comma- or space-separated)",
    )
    .option("--yes", "skip confirmation prompts")
    .option("--force", "destroy even if the node still hosts services (they will be orphaned)")
    .option(
      "--evacuate",
      "first move the current project's cluster-placed services off the node(s), then destroy",
    )
    .option("--env <name>", "target a named environment footprint for --evacuate (same as deploy --env)")
    .option("--timeout <seconds>", "how long --evacuate waits for the moved replicas to come up (default 300)")
    .addHelpText(
      "after",
      [
        "",
        "Refuses by default when a node still hosts scheduled services — destroying it would",
        "orphan their containers (no node reconciles them anymore). Three ways forward:",
        "  --evacuate   move this project's cluster-placed services onto the rest of the pool",
        "               (= `node evacuate`), wait for them to come up, THEN destroy. Run from",
        "               your project directory. Pinned (node/nodes) services and OTHER projects'",
        "               services can't be auto-moved — destroy still refuses unless --force.",
        "  --force      destroy now and orphan whatever is still scheduled there.",
        "  (manual)     `node evacuate <node>` first, then re-run destroy.",
        "",
        "Fully tears the node down: instance + Elastic IP + security group + its per-node IAM",
        "role/profile + S3 state. Use `cluster destroy` to tear down a whole cluster at once.",
        "",
        "Examples:",
        "  $ launchpad node destroy app-2 --evacuate --yes",
        "  $ launchpad node destroy app-2 --force --yes",
      ].join("\n"),
    )
    .action(async (names: string[], _opts, command: Command) => {
      await runDestroy(names, mergedOpts<DestroyOptions>(command));
    });
  applyGlobalOptions(destroy);

  const pause = node
    .command("pause <name>")
    .description("Stop the node's instance to save money (the edge keeps its Elastic IP + disk)")
    .action(async (name: string, _opts, command: Command) => {
      await runPause(name, mergedOpts(command));
    });
  applyGlobalOptions(pause);

  const resume = node
    .command("resume <name>")
    .description("Start a paused node back up")
    .action(async (name: string, _opts, command: Command) => {
      await runResume(name, mergedOpts(command));
    });
  applyGlobalOptions(resume);

  const resize = node
    .command("resize <name>")
    .description("Change a node's EC2 instance type (--evacuate moves services off first — no downtime)")
    .option("--instance-type <type>", "the EC2 instance type to resize to")
    .option(
      "--evacuate",
      "move this project's cluster-placed services off first, resize, then rebalance back (run from the project directory)",
    )
    .option("--env <name>", "environment footprint for --evacuate (same as deploy --env)")
    .option("--timeout <seconds>", "how long --evacuate waits for each convergence (default 300)")
    .option("--dry-run", "show the from→to change without modifying anything")
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "EC2 can only change the type of a stopped instance, so the node is stopped,",
        "retyped, and started — its services are briefly down during the swap. A paused",
        "node stays paused at the new size. Shrinking is blocked when the node's scheduled",
        "services no longer fit. The edge's Elastic IP survives the resize.",
        "",
        "--evacuate makes it non-disruptive for this project's cluster-placed services:",
        "drain them onto the rest of the app pool (= `node evacuate`), wait for them to be",
        "confirmed running elsewhere, resize the emptied node, then rebalance back and wait",
        "again. Needs another app node with room; volume-bearing services can't move (data is node-local),",
        "and the edge node's INGRESS still blips while Caddy restarts.",
        "",
        "Examples:",
        "  $ launchpad node resize node-prod-1 --instance-type t3.large",
        "  $ launchpad node resize node-prod-1 --instance-type t3.large --evacuate --yes",
        "  $ launchpad node resize node-prod-1 --instance-type t3.small --dry-run",
      ].join("\n"),
    )
    .action(async (name: string, _opts, command: Command) => {
      await runResize(name, mergedOpts<ResizeOptions>(command));
    });
  applyGlobalOptions(resize);

  const upgradeAgent = node
    .command("upgrade-agent [name]")
    .description("Publish the role-specific Rust agent binary to S3 and install it on running instance(s)")
    .option("--upload-only", "upload to S3 only — do not restart the on-box agent")
    .option("--agent-version <semver>", "version recorded in the registry (default: this CLI's version)")
    .option("--dry-run", "show targets without uploading or restarting")
    .option("--yes", "skip confirmation prompts")
    .addHelpText(
      "after",
      [
        "",
        "Build the agent binaries first (`pnpm build:agent`) so the CLI ships the latest agent.",
        "With no name, upgrades every node in the cluster that has an EC2 instance.",
        "Each node receives the binary for ITS role (edge → Caddy router, app → Docker",
        "reconciler); nodes still on the legacy TypeScript agent are migrated in place",
        "(systemd unit rewritten, no re-provision; an edge also stops its idle Docker).",
        "",
        "Examples:",
        "  $ launchpad node upgrade-agent node-edge",
        "  $ launchpad node upgrade-agent --yes",
        "  $ launchpad node upgrade-agent --upload-only   # S3 only, manual install",
      ].join("\n"),
    )
    .action(async (name: string | undefined, _opts, command: Command) => {
      await runUpgradeAgent(name, mergedOpts<UpgradeAgentOptions>(command));
    });
  applyGlobalOptions(upgradeAgent);

  const installLogging = node
    .command("install-logging [name]")
    .description("Install CloudWatch log shipping on an existing node (IAM + CloudWatch Agent)")
    .option("--dry-run", "show targets without changing IAM or installing anything")
    .option("--yes", "skip confirmation prompts")
    .addHelpText(
      "after",
      [
        "",
        "New nodes get logging automatically at provision time. Run this on nodes created",
        "before logging existed — it updates the node's IAM policy and installs the Amazon",
        "CloudWatch Agent over SSM. Idempotent. With no name, targets every node in the cluster.",
        "",
        "Examples:",
        "  $ launchpad node install-logging node-prod-1",
        "  $ launchpad node install-logging --yes      # whole cluster",
      ].join("\n"),
    )
    .action(async (name: string | undefined, _opts, command: Command) => {
      await runInstallLogging(name, mergedOpts<InstallLoggingOptions>(command));
    });
  applyGlobalOptions(installLogging);

  const reconcile = node
    .command("reconcile [name]")
    .description("Reconcile EC2 reality against the registry (repair console-side drift)")
    .option("--dry-run", "show drift without changing anything")
    .option("--no-recreate", "repair stopped nodes but fail (don't replace) a terminated instance")
    .option("--yes", "skip confirmation prompts")
    .addHelpText(
      "after",
      [
        "",
        "With no name, reconciles every node in the cluster. Detects nodes that were",
        "stopped or terminated in the AWS console and starts / replaces them so the",
        "registry matches reality. A replacement reuses the same node id (and the edge's Elastic IP).",
        "",
        "Examples:",
        "  $ launchpad node reconcile                 # whole cluster",
        "  $ launchpad node reconcile node-prod-1     # one node",
        "  $ launchpad node reconcile --dry-run       # just show drift",
      ].join("\n"),
    )
    .action(async (name: string | undefined, _opts, command: Command) => {
      await runReconcile(name, mergedOpts<ReconcileOptions>(command));
    });
  applyGlobalOptions(reconcile);

  const evacuate = node
    .command("evacuate <name>")
    .description("Move the current project's cluster-placed services OFF a node before pause/destroy")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--dry-run", "show the moves without writing any state")
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "Run from your project directory. Evacuate replans this footprint's cluster-placed",
        "services (those that omit node/nodes) across the rest of the app pool — reusing each",
        "service's published image — so the named node is freed. It's the safe pre-step to",
        "`node pause/destroy`, which refuse to orphan scheduled services.",
        "",
        "Pinned (node/nodes) services can't be evacuated — their placement is config-locked.",
        "A node hosting other projects needs each of them evacuated too. Equivalent to",
        "`launchpad rebalance --drain <name>`.",
        "",
        "Examples:",
        "  $ launchpad node evacuate node-prod-2 --dry-run",
        "  $ launchpad node evacuate node-prod-2 --yes",
      ].join("\n"),
    )
    .action(async (name: string, _opts, command: Command) => {
      const opts = mergedOpts<RebalanceOptions>(command);
      await runRebalance({ ...opts, drain: name });
    });
  applyGlobalOptions(evacuate);

  registerMonitor(node);
}
