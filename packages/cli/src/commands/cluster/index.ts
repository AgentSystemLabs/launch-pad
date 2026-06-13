import { Command } from "commander";
import {
  type ClusterConfig,
  CLUSTERS_PREFIX,
  DEFAULT_CLUSTER,
  LABEL_REGEX,
  type NodeRegistryEntry,
  nodeFrontsIngress,
  nodeRegistryKey,
  nodeUsesElasticIp,
  parseNodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import { awsErrorName } from "../../aws/errors";
import { deletePrefix, getJson, listClusterIds, listNodeIds, putJson } from "../../aws/s3-state";
import { loadNodeDesiredStates } from "../../deploy/deployed-footprint";
import { loadEnvMarkers } from "../../preview/markers";
import {
  buildEnvFootprintSummaries,
  describeEnvMarker,
  type FootprintServiceSummary,
} from "../../project/footprint-view";
import {
  deleteSecurityGroup,
  releaseEip,
  stopInstance,
  terminateInstance,
} from "../../aws/ec2";
import { createCodeBuildClient, deleteRemoteBuildInfra } from "../../aws/codebuild";
import { deleteNodeIam } from "../../aws/iam";
import { getClusterConfig, putClusterConfig } from "../../cluster/store";
import {
  clearDefaultCluster,
  effectiveCluster,
  type LocalConfig,
  loadLocalConfig,
  localConfigPath,
  removeClusterTarget,
  resolveClusterTarget,
  setDefaultCluster,
  upsertClusterTarget,
} from "../../config/local";
import { CliError } from "../../errors";
import { assertValidNodeId } from "../../validate-node-id";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../../globals";
import { resumeNode } from "../../provision/provision-node";
import { panel, table } from "../../ui/box";
import { isJsonMode, log, printJson, spinner } from "../../ui/log";
import { confirm } from "../../ui/prompt";
import { color } from "../../ui/theme";

function nowIso(): string {
  return new Date().toISOString();
}

function assertClusterName(name: string): void {
  if (name === DEFAULT_CLUSTER) {
    throw new CliError(`"${DEFAULT_CLUSTER}" is the implicit cluster and can't be created`, {
      hint: "pick another name, e.g. `lower` or `prod`",
    });
  }
  if (!LABEL_REGEX.test(name)) {
    throw new CliError(`invalid cluster name "${name}" (lowercase letters, numbers and hyphens, 1–40 chars)`);
  }
}

// ── create ─────────────────────────────────────────────────────────────────────

interface CreateOptions extends GlobalOpts {
  roleArn?: string;
  edge?: string;
}

async function runCreate(name: string, opts: CreateOptions): Promise<void> {
  assertClusterName(name);

  // Persist the local target first (this is the only place accounts/creds live).
  upsertClusterTarget(name, {
    region: opts.region,
    profile: opts.profile,
    roleArn: opts.roleArn,
  });
  log.step(`saved cluster target → ${color.dim(localConfigPath())}`);

  if (opts.roleArn) {
    log.warn(`cluster "${name}" uses a cross-account roleArn — activation lands in Phase 2`);
    log.dim("  the local target is saved; re-run once cross-account support ships");
    if (isJsonMode()) printJson({ cluster: name, roleArn: opts.roleArn, activated: false });
    return;
  }

  const aws = await prepareAws({ ...opts, cluster: name }, { ensureBucket: true });

  const existing = await getClusterConfig(aws, name);
  const config: ClusterConfig = existing
    ? { ...existing, region: aws.region, ...(opts.edge ? { defaultEdge: opts.edge } : {}) }
    : {
        clusterId: name,
        defaultEdge: opts.edge ?? null,
        region: aws.region,
        createdAt: nowIso(),
        createdBy: aws.callerArn,
        autoscale: null,
      };
  await putClusterConfig(aws, config);

  if (isJsonMode()) {
    printJson({ cluster: config, account: aws.accountId, bucket: aws.bucket });
    return;
  }
  panel(`Cluster ${name}`, [
    ...table([
      ["account / region", `${aws.accountId} ${color.dim(aws.region)}`],
      ["state bucket", aws.bucket],
      ["default edge", config.defaultEdge ?? color.dim("none yet")],
    ]),
    "",
    color.dim("add nodes with `launchpad node create <name> --cluster " + name + "`"),
    color.dim("the first edge node created in this cluster becomes its default edge."),
  ]);
}

// ── list ───────────────────────────────────────────────────────────────────────

/** List named clusters in S3, treating a not-yet-created bucket as empty. */
async function safeListClusterIds(aws: AwsEnv): Promise<string[]> {
  try {
    return await listClusterIds(aws.s3, aws.bucket);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
}

export type ClusterListSource = "implicit" | "local" | "s3" | "both";

export interface ClusterListRow {
  clusterId: string;
  region: string | null;
  source: ClusterListSource;
}

export function buildClusterListRows(
  local: LocalConfig,
  s3Ids: string[],
  s3Region: string | undefined,
): ClusterListRow[] {
  const localNames = Object.keys(local.clusters);
  const s3Set = new Set(s3Ids);
  const named = [...new Set([...localNames, ...s3Ids])]
    .filter((id) => id !== DEFAULT_CLUSTER)
    .sort()
    .map((id) => ({
      clusterId: id,
      region: local.clusters[id]?.region ?? (s3Set.has(id) ? s3Region : undefined) ?? null,
      source: (local.clusters[id] && s3Set.has(id) ? "both" : local.clusters[id] ? "local" : "s3") as ClusterListSource,
    }));

  return [
    {
      clusterId: DEFAULT_CLUSTER,
      region: s3Region ?? null,
      source: "implicit",
    },
    ...named,
  ];
}

async function runList(opts: GlobalOpts): Promise<void> {
  const local = loadLocalConfig();

  // S3 is the authoritative registry: surface clusters that exist there even when
  // they were created implicitly by `deploy --cluster X` and never written locally.
  // The bucket is region-scoped, so an id found in S3 lives in `aws.region`.
  let s3Ids: string[] = [];
  let s3Region: string | undefined;
  let s3Reachable = true;
  try {
    const aws = await prepareAws(opts);
    s3Region = aws.region;
    s3Ids = await safeListClusterIds(aws);
  } catch {
    s3Reachable = false; // no creds / no account — degrade to local-only.
  }

  const rows = buildClusterListRows(local, s3Ids, s3Region);
  const activeDefault = local.defaultCluster ?? DEFAULT_CLUSTER;

  if (isJsonMode()) {
    printJson({
      defaultCluster: local.defaultCluster ?? null,
      clusters: rows.map((row) => ({
        clusterId: row.clusterId,
        ...local.clusters[row.clusterId],
        region: row.region,
        source: row.source,
      })),
    });
    return;
  }
  log.plain();
  for (const row of rows) {
    const id = row.clusterId;
    const t = local.clusters[id];
    const where = t?.roleArn
      ? color.dim(`role ${t.roleArn}`)
      : t?.profile
        ? color.dim(`profile ${t.profile}`)
        : color.dim("ambient creds");
    const mark = id === activeDefault ? color.green(" (default)") : "";
    const tag =
      row.source === "implicit"
        ? color.dim(" (implicit)")
        : row.source === "s3"
          ? color.yellow(" (in S3 — not configured locally)")
          : "";
    log.plain(`  ${color.cyan(id)}${mark}${tag}  ${color.dim(row.region ?? "region: inherited")}  ${where}`);
  }
  if (!s3Reachable) {
    log.dim("  (couldn't reach S3 — showing locally-configured clusters only)");
  }
  log.plain();
}

// ── show ───────────────────────────────────────────────────────────────────────

/** Compact view of one scheduled service from a node's desired.json. */
export interface ClusterServiceSummary {
  project: string;
  service: string;
  replicas: number;
  image: string;
  domain: string | null;
  cron?: string;
}

export interface ClusterNodeWorkload {
  nodeId: string;
  services: ClusterServiceSummary[];
}

/** Map raw desired services to the stable summary `cluster show` prints. Pure. */
export function summarizeClusterServices(
  services: Array<{
    project: string;
    service: string;
    replicas: number;
    image: string;
    ingress: { domain: string } | null;
    cron?: string;
  }>,
): ClusterServiceSummary[] {
  return services
    .map((s) => ({
      project: s.project,
      service: s.service,
      replicas: s.replicas,
      image: s.image,
      domain: s.ingress?.domain ?? null,
      ...(s.cron !== undefined ? { cron: s.cron } : {}),
    }))
    .sort((a, b) =>
      `${a.project}/${a.service}`.localeCompare(`${b.project}/${b.service}`),
    );
}

function formatServiceLine(s: ClusterServiceSummary): string {
  const tag = s.image.split(":").pop() ?? s.image;
  const replicas = s.replicas > 1 ? `  ${color.dim(`×${s.replicas}`)}` : "";
  const domain = s.domain ? `  ${color.dim(s.domain)}` : "";
  const cron = s.cron ? `  ${color.dim(`cron ${s.cron}`)}` : "";
  return `    ${color.cyan(`${s.project}/${s.service}`)}${replicas}  ${color.dim(tag)}${domain}${cron}`;
}

function formatEnvServiceLine(s: FootprintServiceSummary): string {
  const tag = s.image.split(":").pop() ?? s.image;
  const replicas = s.replicas > 1 ? `  ${color.dim(`×${s.replicas}`)}` : "";
  const domain = s.domain ? `  ${color.dim(s.domain)}` : "";
  const cron = s.cron ? `  ${color.dim(`cron ${s.cron}`)}` : "";
  const nodes = s.nodeIds.map((id) => color.cyan(id)).join(", ");
  return `    ${color.cyan(s.service)}${replicas}  ${color.dim(tag)}${domain}${cron}  ${color.dim("→")} ${nodes}`;
}

async function runShow(name: string, opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws({ ...opts, cluster: name });
  const config = await getClusterConfig(aws, name);
  const ids = [...(await listNodeIds(aws.s3, aws.bucket, name))].sort();

  // The cluster must exist somewhere: a local target, a cluster.json, or member
  // nodes in S3. (The implicit `default` cluster always exists and has no cluster.json.)
  if (name !== DEFAULT_CLUSTER && !config && ids.length === 0 && !resolveClusterTarget(name)) {
    throw new CliError(`cluster "${name}" not found`, {
      hint: `nothing in S3 or local config — create it: launchpad cluster create ${name} --region <region>`,
    });
  }

  const registryById = new Map<string, NodeRegistryEntry>();
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(name, id));
    if (obj) {
      try {
        registryById.set(id, parseNodeRegistryEntry(obj.raw));
      } catch {
        /* skip malformed */
      }
    }
  }
  const nodes = [...registryById.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const nodeDesiredStates = await loadNodeDesiredStates(aws.s3, aws.bucket, name);
  const desiredById = new Map(nodeDesiredStates.map((s) => [s.nodeId, s.services]));
  const workloads: ClusterNodeWorkload[] = ids.map((nodeId) => ({
    nodeId,
    services: summarizeClusterServices(desiredById.get(nodeId) ?? []),
  }));
  const scheduledServices = workloads.reduce((n, w) => n + w.services.length, 0);
  const nowMs = Date.now();
  const envSummaries = buildEnvFootprintSummaries(await loadEnvMarkers(aws), nodeDesiredStates, nowMs);

  if (isJsonMode()) {
    printJson({
      cluster: config,
      account: aws.accountId,
      region: aws.region,
      nodes,
      workloads,
      scheduledServices,
      environments: envSummaries.map(({ marker, expired, services }) => ({
        ...marker,
        expired,
        services,
      })),
    });
    return;
  }
  panel(`Cluster ${name}`, [
    ...table([
      ["account / region", `${aws.accountId} ${color.dim(aws.region)}`],
      ["state bucket", aws.bucket],
      ["default edge", config?.defaultEdge ?? color.dim("none")],
      ["nodes", String(ids.length)],
      ["scheduled services", String(scheduledServices)],
      ["environments", String(envSummaries.length)],
    ]),
  ]);
  if (ids.length > 0) {
    const lines: string[] = [];
    let missingRegistryCount = 0;
    for (const nodeId of ids) {
      const entry = registryById.get(nodeId);
      if (!entry) missingRegistryCount += 1;
      const meta = entry
        ? `${color.cyan(nodeId)}  ${color.dim(`${entry.role} · ${entry.instanceType}`)}`
        : `${color.cyan(nodeId)}  ${color.yellow("no registry entry")}`;
      lines.push(meta);
      const services = workloads.find((w) => w.nodeId === nodeId)?.services ?? [];
      if (services.length === 0) {
        lines.push(color.dim("    no services scheduled"));
      } else {
        for (const s of services) lines.push(formatServiceLine(s));
      }
    }
    panel("Nodes & services", lines);
    if (missingRegistryCount > 0) {
      log.dim(`  remove stale node state with \`launchpad node prune --yes --cluster ${name}\``);
    }
  }
  if (envSummaries.length > 0) {
    const envLines: string[] = [];
    for (const env of envSummaries) {
      const header = describeEnvMarker(env.marker, nowMs);
      const domains =
        env.marker.domains.length > 0 ? `  ${color.dim(env.marker.domains.join(", "))}` : "";
      envLines.push((env.expired ? color.yellow(header) : header) + domains);
      if (env.services.length === 0) {
        envLines.push(color.dim("    nothing scheduled"));
      } else {
        for (const s of env.services) envLines.push(formatEnvServiceLine(s));
      }
    }
    panel("Environments", envLines);
    log.dim("  destroy one: launchpad destroy --env <name> · list only: launchpad destroy --list-envs");
  }
}

// ── set-edge ─────────────────────────────────────────────────────────────────────

async function runSetEdge(name: string, nodeId: string, opts: GlobalOpts): Promise<void> {
  assertValidNodeId(nodeId);
  if (name === DEFAULT_CLUSTER) {
    throw new CliError("the default cluster has no cluster.json to record a default edge", {
      hint: "the default cluster resolves its edge from the registry's single edge-role node — create one with `launchpad node create <name> --role edge`",
    });
  }
  const aws = await prepareAws({ ...opts, cluster: name });
  const config = await getClusterConfig(aws, name);
  if (!config) {
    throw new CliError(`cluster "${name}" has no cluster.json`, {
      hint: `create it: launchpad cluster create ${name} --region <region>`,
    });
  }
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(name, nodeId));
  if (!obj) {
    throw new CliError(`node "${nodeId}" does not exist in cluster "${name}"`);
  }
  const entry = parseNodeRegistryEntry(obj.raw);
  if (!nodeFrontsIngress(entry.role)) {
    throw new CliError(`node "${nodeId}" is not an edge (role=${entry.role})`);
  }

  await putClusterConfig(aws, { ...config, defaultEdge: nodeId });
  if (isJsonMode()) {
    printJson({ cluster: name, defaultEdge: nodeId });
    return;
  }
  log.success(`cluster ${color.cyan(name)} now routes through ${color.cyan(nodeId)}`);
}

// ── use / current (active-cluster context) ───────────────────────────────────────

/**
 * Validate + persist a `cluster use` switch — the local-only half (no AWS). `default`
 * clears the persistent default (reverting to the implicit cluster); any other name
 * must already be configured locally. Returns the resolved default (`null` = cleared).
 */
export function applyClusterUse(name: string): { defaultCluster: string | null } {
  if (name === DEFAULT_CLUSTER) {
    clearDefaultCluster();
    return { defaultCluster: null };
  }
  if (!resolveClusterTarget(name)) {
    throw new CliError(`cluster "${name}" is not configured locally`, {
      hint: `create it: launchpad cluster create ${name} --region <region>`,
    });
  }
  setDefaultCluster(name);
  return { defaultCluster: name };
}

async function runUse(name: string, opts: GlobalOpts): Promise<void> {
  const { defaultCluster } = applyClusterUse(name);
  const cluster = defaultCluster ?? DEFAULT_CLUSTER;
  const target = resolveClusterTarget(cluster);
  const profile = opts.profile ?? target?.profile;
  const roleArn = target?.roleArn;

  // The switch already persisted; resolve account/region for context best-effort so a
  // creds/roleArn issue can't undo a successful target change.
  let account: string | undefined;
  let region = opts.region ?? target?.region;
  try {
    const aws = await prepareAws({ ...opts, cluster });
    account = aws.accountId;
    region = aws.region;
  } catch {
    /* show locally-known details only */
  }

  if (isJsonMode()) {
    printJson({
      cluster,
      defaultCluster,
      account: account ?? null,
      region: region ?? null,
      profile: profile ?? null,
      ...(roleArn ? { roleArn } : {}),
    });
    return;
  }

  if (defaultCluster === null) {
    log.success(`switched to the implicit ${color.cyan(DEFAULT_CLUSTER)} cluster`);
  } else {
    log.success(`switched to cluster ${color.cyan(cluster)}`);
  }
  const rows: Array<[string, string]> = [
    ["account", account ?? color.dim("unresolved (check AWS credentials)")],
    ["region", region ?? color.dim("inherited from AWS config")],
    ["profile", profile ?? color.dim("ambient creds")],
  ];
  if (roleArn) rows.push(["roleArn", roleArn]);
  for (const line of table(rows)) log.plain(`  ${line}`);
  log.dim(`  future commands target this cluster — override per-command with ${color.cyan("--cluster")}`);
}

async function runCurrent(opts: GlobalOpts): Promise<void> {
  const local = loadLocalConfig();
  const eff = effectiveCluster(opts, local);

  let account: string | undefined;
  let region = eff.region;
  let bucket: string | undefined;
  try {
    const aws = await prepareAws({ ...opts, cluster: eff.cluster });
    account = aws.accountId;
    region = aws.region;
    bucket = aws.bucket;
  } catch {
    /* creds/roleArn unreachable — show locally-known details only */
  }

  if (isJsonMode()) {
    printJson({
      cluster: eff.cluster,
      defaultCluster: local.defaultCluster ?? null,
      effectiveCluster: eff.cluster,
      isImplicitDefault: eff.isImplicitDefault,
      overridden: eff.overridden,
      account: account ?? null,
      region: region ?? null,
      profile: eff.profile ?? null,
      ...(eff.roleArn ? { roleArn: eff.roleArn } : {}),
      bucket: bucket ?? null,
    });
    return;
  }

  const rows: Array<[string, string]> = [
    ["account", account ?? color.dim("unresolved (check AWS credentials)")],
    ["region", region ?? color.dim("inherited from AWS config")],
    ["profile", eff.profile ?? color.dim("ambient creds")],
  ];
  if (eff.roleArn) rows.push(["roleArn", eff.roleArn]);
  if (bucket) rows.push(["state bucket", bucket]);
  panel(
    eff.isImplicitDefault ? `Cluster ${eff.cluster} ${color.dim("(implicit default)")}` : `Cluster ${eff.cluster}`,
    [...table(rows)],
  );
  if (eff.overridden) {
    log.dim(`  --cluster overrides your default (${color.cyan(eff.persistedDefault)}) for this command only`);
  } else if (eff.isImplicitDefault) {
    log.dim(`  no default set — using the implicit ${color.cyan(DEFAULT_CLUSTER)} cluster (ambient creds, legacy S3 keys)`);
  } else {
    log.dim(`  this is your persistent default — change it with ${color.cyan("launchpad cluster use <name>")}`);
  }
}

// ── group lifecycle (pause / resume / destroy) ───────────────────────────────────

interface GroupOptions extends GlobalOpts {
  yes?: boolean;
}

/**
 * Resolve AWS for a named cluster, allowing any cluster that exists either locally
 * (a configured target) OR in S3 (created implicitly by `deploy --cluster X`). S3 is
 * the authoritative registry, so a missing local target is not on its own an error.
 */
async function prepareClusterAws(name: string, opts: GlobalOpts): Promise<AwsEnv> {
  const aws = await prepareAws({ ...opts, cluster: name });
  if (name === DEFAULT_CLUSTER || resolveClusterTarget(name)) return aws;
  const config = await getClusterConfig(aws, name);
  if (config || (await listNodeIds(aws.s3, aws.bucket, name)).length > 0) return aws;
  throw new CliError(`cluster "${name}" not found`, {
    hint: `nothing in S3 or local config — create it: launchpad cluster create ${name} --region <region>`,
  });
}

export function resolveClusterCommandTarget(
  name: string | undefined,
  opts: GlobalOpts,
  local: LocalConfig = loadLocalConfig(),
): string {
  return name ?? effectiveCluster(opts, local).cluster;
}

export function resolveClusterSetEdgeArgs(
  nameOrNodeId: string | undefined,
  nodeId: string | undefined,
  opts: GlobalOpts,
  local: LocalConfig = loadLocalConfig(),
): { cluster: string; nodeId: string } {
  if (!nameOrNodeId) {
    throw new CliError("missing required argument 'nodeId'", {
      hint: "usage: launchpad cluster set-edge [cluster] <nodeId>",
    });
  }
  if (nodeId === undefined) {
    return { cluster: resolveClusterCommandTarget(undefined, opts, local), nodeId: nameOrNodeId };
  }
  return { cluster: resolveClusterCommandTarget(nameOrNodeId, opts, local), nodeId };
}

/** Load every node registry entry in a cluster (skips malformed). */
async function loadClusterNodes(aws: AwsEnv, name: string): Promise<NodeRegistryEntry[]> {
  const ids = await listNodeIds(aws.s3, aws.bucket, name);
  const nodes: NodeRegistryEntry[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(name, id));
    if (!obj) continue;
    try {
      nodes.push(parseNodeRegistryEntry(obj.raw));
    } catch {
      /* skip malformed */
    }
  }
  return nodes;
}

async function pauseClusterNode(
  aws: AwsEnv,
  clusterName: string,
  node: NodeRegistryEntry,
): Promise<string> {
  await stopInstance(aws.ec2, node.instanceId!);
  await putJson(aws.s3, aws.bucket, nodeRegistryKey(clusterName, node.nodeId), { ...node, state: "stopped" });
  return node.nodeId;
}

async function resumeClusterNode(
  aws: AwsEnv,
  node: NodeRegistryEntry,
): Promise<{ nodeId: string; address: string | null }> {
  const updated = await resumeNode(aws, node);
  const addr = (nodeUsesElasticIp(updated.role) ? updated.publicIp : updated.privateIp) ?? null;
  return { nodeId: node.nodeId, address: addr };
}

async function runPause(name: string, opts: GroupOptions): Promise<void> {
  const aws = await prepareClusterAws(name, opts);
  const pausable = (await loadClusterNodes(aws, name)).filter((n) => n.instanceId);

  if (pausable.length === 0) {
    if (isJsonMode()) return printJson({ cluster: name, paused: [] });
    log.info(`cluster "${name}" has no instances to pause`);
    return;
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`stop ${pausable.length} instance(s) in cluster ${color.cyan(name)}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  let paused: string[];
  if (pausable.length === 1) {
    const node = pausable[0]!;
    const spin = spinner(`pausing ${node.nodeId} (stopping ${node.instanceId})…`).start();
    try {
      paused = [await pauseClusterNode(aws, name, node)];
      spin.succeed(`paused node ${color.cyan(node.nodeId)}`);
    } catch (error) {
      if (spin.isSpinning) spin.fail(`pause failed for ${node.nodeId}`);
      throw error;
    }
  } else {
    const spin = spinner(`pausing ${pausable.length} nodes…`).start();
    try {
      paused = await Promise.all(pausable.map((node) => pauseClusterNode(aws, name, node)));
      if (spin.isSpinning) {
        spin.succeed(
          `paused ${paused.length} nodes: ${paused.map((id) => color.cyan(id)).join(", ")}`,
        );
      }
    } catch (error) {
      if (spin.isSpinning) spin.fail("pause failed");
      throw error;
    }
  }

  if (isJsonMode()) return printJson({ cluster: name, paused });
  log.dim("  compute billing stops; EBS volumes (and any Elastic IP) still incur a small charge");
  log.dim(`  resume with: ${color.cyan(`launchpad cluster resume ${name}`)}`);
}

async function runResume(name: string, opts: GroupOptions): Promise<void> {
  const aws = await prepareClusterAws(name, opts);
  const resumable = (await loadClusterNodes(aws, name)).filter((n) => n.instanceId);

  if (resumable.length === 0) {
    if (isJsonMode()) return printJson({ cluster: name, resumed: [] });
    log.info(`cluster "${name}" has no instances to resume`);
    return;
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`start ${resumable.length} instance(s) in cluster ${color.cyan(name)}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  let resumed: Array<{ nodeId: string; address: string | null }>;
  if (resumable.length === 1) {
    const node = resumable[0]!;
    const spin = spinner(`resuming ${node.nodeId} (starting ${node.instanceId})…`).start();
    try {
      resumed = [await resumeClusterNode(aws, node)];
      const { address } = resumed[0]!;
      const label = nodeUsesElasticIp(node.role) ? "public ip" : "private ip";
      spin.succeed(`resumed node ${color.cyan(node.nodeId)} at ${label} ${address ?? "?"}`);
    } catch (error) {
      if (spin.isSpinning) spin.fail(`resume failed for ${node.nodeId}`);
      throw error;
    }
  } else {
    const spin = spinner(`resuming ${resumable.length} nodes…`).start();
    try {
      resumed = await Promise.all(resumable.map((node) => resumeClusterNode(aws, node)));
      if (spin.isSpinning) {
        spin.succeed(
          `resumed ${resumed.length} nodes: ${resumed.map((r) => color.cyan(r.nodeId)).join(", ")}`,
        );
      }
    } catch (error) {
      if (spin.isSpinning) spin.fail("resume failed");
      throw error;
    }
  }

  if (isJsonMode()) return printJson({ cluster: name, resumed });
  if (resumable.some((n) => nodeUsesElasticIp(n.role) && !n.eipAllocationId)) {
    log.warn("an edge node has no Elastic IP, so its public IP may have changed — re-check `node show`");
  }
}

async function runDestroy(name: string, opts: GroupOptions): Promise<void> {
  if (name === DEFAULT_CLUSTER) {
    throw new CliError("the implicit `default` cluster can't be destroyed as a group", {
      hint: "destroy its nodes individually with `launchpad node destroy <name>`",
    });
  }
  const aws = await prepareClusterAws(name, opts);
  const nodes = await loadClusterNodes(aws, name);

  if (opts.yes !== true && !isJsonMode()) {
    log.warn(`this terminates ${nodes.length} node(s) and deletes ALL state for cluster "${name}" — irreversible`);
    const ok = await confirm(`destroy cluster ${color.cyan(name)}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  // Best-effort, phased teardown: terminate every instance FIRST so no edge↔app
  // security-group cross-reference (or lingering ENI) blocks the SG deletes; then
  // release EIPs, delete SGs, and finally sweep all S3 state. Each step collects
  // warnings instead of aborting so a single stuck resource can't strand the rest
  // (this runs from the e2e harness's teardown `finally`).
  const warnings: string[] = [];
  const withInstances = nodes.filter((n) => n.instanceId);

  const term = spinner("terminating instances…").start();
  for (const node of withInstances) {
    term.text = `terminating ${node.nodeId} (${node.instanceId})`;
    try {
      await terminateInstance(aws.ec2, node.instanceId!);
    } catch (error) {
      warnings.push(`terminate ${node.nodeId}: ${(error as Error).message}`);
    }
  }
  term.succeed(`terminated ${withInstances.length} instance(s)`);

  for (const node of nodes) {
    if (!node.eipAllocationId) continue;
    try {
      await releaseEip(aws.ec2, node.eipAllocationId);
    } catch (error) {
      warnings.push(`release EIP ${node.eipAllocationId} (${node.nodeId}): ${(error as Error).message}`);
    }
  }

  const sg = spinner("deleting security groups…").start();
  for (const node of nodes) {
    if (!node.securityGroupId) continue;
    try {
      await deleteSecurityGroup(aws.ec2, node.securityGroupId);
    } catch (error) {
      warnings.push(`delete SG ${node.securityGroupId} (${node.nodeId}): ${(error as Error).message}`);
    }
  }
  sg.succeed("deleted security groups");

  // A full cluster teardown deletes per-node IAM too (unlike `node destroy`,
  // which leaves it for a same-name re-create). Best-effort.
  const iamSpin = spinner("deleting IAM roles…").start();
  for (const node of nodes) {
    try {
      await deleteNodeIam(aws.iam, name, node.nodeId);
    } catch (error) {
      warnings.push(`delete IAM ${node.nodeId}: ${(error as Error).message}`);
    }
  }
  iamSpin.succeed("deleted IAM roles");

  // Remote-build infra (`deploy --remote-build`) is per-cluster too — drop the
  // CodeBuild project and its service role. Best-effort and a no-op when the
  // cluster never used remote builds.
  try {
    await deleteRemoteBuildInfra(createCodeBuildClient(aws.region), aws.iam, aws.logs, name);
  } catch (error) {
    warnings.push(`delete remote-build infra: ${(error as Error).message}`);
  }

  // Sweep the WHOLE cluster prefix in one shot — node states, cluster.json, and
  // any orphans (e.g. an agent bundle from a half-finished provision that never
  // wrote a registry entry, so the per-node loop above wouldn't know about it).
  const state = spinner("removing cluster state…").start();
  try {
    const removed = await deletePrefix(aws.s3, aws.bucket, `${CLUSTERS_PREFIX}${name}/`);
    state.succeed(`removed cluster state (${removed} object(s))`);
  } catch (error) {
    warnings.push(`delete cluster state: ${(error as Error).message}`);
    if (state.isSpinning) state.fail("could not remove all cluster state");
  }

  // Drop the local AWS target so `cluster list` no longer shows it.
  removeClusterTarget(name);

  if (isJsonMode()) {
    return printJson({ cluster: name, destroyed: nodes.map((n) => n.nodeId), warnings });
  }
  for (const w of warnings) log.warn(w);
  log.success(`destroyed cluster ${color.cyan(name)} (${nodes.length} node(s))`);
}

// ── registration ────────────────────────────────────────────────────────────────

export function registerCluster(program: Command): void {
  const cluster = program
    .command("cluster")
    .description("Manage clusters — scoped groups of nodes that share an edge (and optionally an AWS account)");

  const create = cluster
    .command("create <name>")
    .description("Configure a cluster's AWS target locally and write its cluster.json")
    .option("--role-arn <arn>", "assume this role for the cluster's account (cross-account; Phase 2)")
    .option("--edge <nodeId>", "set the cluster's default edge up front")
    .action(async (name: string, _opts, command: Command) => {
      await runCreate(name, mergedOpts<CreateOptions>(command));
    });
  applyGlobalOptions(create);

  const list = cluster
    .command("list")
    .description("List locally-configured clusters")
    .action(async (_opts, command: Command) => {
      await runList(mergedOpts(command));
    });
  applyGlobalOptions(list);

  const show = cluster
    .command("show [name]")
    .description("Show a cluster's config, account, member nodes, scheduled services, and preview environments")
    .action(async (name: string | undefined, _opts, command: Command) => {
      const opts = mergedOpts(command);
      await runShow(resolveClusterCommandTarget(name, opts), opts);
    });
  applyGlobalOptions(show);

  const setEdge = cluster
    .command("set-edge")
    .argument("[nameOrNodeId]", "cluster name, or node id when using the active cluster")
    .argument("[nodeId]", "edge node id when a cluster name is provided")
    .usage("[cluster] <nodeId> [options]")
    .description("Set the cluster's default edge (the node whose Caddy fronts its web services)")
    .action(async (nameOrNodeId: string | undefined, nodeId: string | undefined, _opts, command: Command) => {
      const opts = mergedOpts(command);
      const target = resolveClusterSetEdgeArgs(nameOrNodeId, nodeId, opts);
      await runSetEdge(target.cluster, target.nodeId, opts);
    });
  applyGlobalOptions(setEdge);

  const use = cluster
    .command("use <name>")
    .alias("switch")
    .alias("target")
    .description("Set the default cluster for future commands (use `default` to revert to the implicit cluster)")
    .action(async (name: string, _opts, command: Command) => {
      await runUse(name, mergedOpts(command));
    });
  applyGlobalOptions(use);

  const current = cluster
    .command("current")
    .description("Show the cluster future commands target (account, region, profile)")
    .action(async (_opts, command: Command) => {
      await runCurrent(mergedOpts(command));
    });
  applyGlobalOptions(current);

  const pause = cluster
    .command("pause [name]")
    .description("Stop every node in the target cluster to save money (the edge keeps its Elastic IP + disk)")
    .option("--yes", "skip confirmation prompts")
    .action(async (name: string | undefined, _opts, command: Command) => {
      const opts = mergedOpts<GroupOptions>(command);
      await runPause(resolveClusterCommandTarget(name, opts), opts);
    });
  applyGlobalOptions(pause);

  const resume = cluster
    .command("resume [name]")
    .description("Start every paused node in a cluster back up")
    .option("--yes", "skip confirmation prompts")
    .action(async (name: string | undefined, _opts, command: Command) => {
      const opts = mergedOpts<GroupOptions>(command);
      await runResume(resolveClusterCommandTarget(name, opts), opts);
    });
  applyGlobalOptions(resume);

  const destroy = cluster
    .command("destroy [name]")
    .description("Terminate every node in a cluster, release IPs, and delete all its S3 state")
    .option("--yes", "skip confirmation prompts")
    .action(async (name: string | undefined, _opts, command: Command) => {
      const opts = mergedOpts<GroupOptions>(command);
      await runDestroy(resolveClusterCommandTarget(name, opts), opts);
    });
  applyGlobalOptions(destroy);
}
