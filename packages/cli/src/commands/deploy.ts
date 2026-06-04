import { resolve } from "node:path";
import { Command } from "commander";
import {
  type CapacityServiceDemand,
  type DesiredState,
  type NodeRegistryEntry,
  PROTOCOL_VERSION,
  type ServiceConfig,
  type ServiceDecl,
  checkCapacity,
  desiredKey,
  ecrRepositoryName,
  emptyDesiredState,
  mergeProjectServices,
  nodeRegistryKey,
  parseDesiredState,
  parseNodeRegistryEntry,
  sharesToVcpu,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { ensureRepository, getEcrAuth, imageExists } from "../aws/ecr";
import { getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { loadConfig } from "../config/load";
import { buildAndPush, checkDocker, computeImageTag, dockerLoginEcr, ensureBuilder } from "../deploy/build";
import { waitForConvergence, type WatchResult, type WatchTarget } from "../deploy/watch";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts } from "../globals";
import { panel, table } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { color } from "../ui/theme";

interface DeployOptions extends GlobalOpts {
  service?: string;
  node?: string;
  wait?: boolean;
  timeout?: string;
  yes?: boolean;
  dryRun?: boolean;
}

interface BuiltService {
  decl: ServiceDecl;
  repoName: string;
  repoUri: string;
  tag: string;
  image: string;
  contextDir: string;
  dockerfilePath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toServiceConfig(project: string, b: BuiltService): ServiceConfig {
  return {
    project,
    service: b.decl.name,
    image: b.image,
    cpu: b.decl.cpu,
    memory: b.decl.memory,
    env: b.decl.env,
    ingress:
      b.decl.domain !== undefined && b.decl.port !== undefined
        ? { domain: b.decl.domain, port: b.decl.port }
        : null,
  };
}

/** The full set of cpu/memory demands a node would carry after this deploy. */
function capacityDemands(
  project: string,
  state: DesiredState,
  decls: ServiceDecl[],
): CapacityServiceDemand[] {
  const others = state.services
    .filter((s) => s.project !== project)
    .map((s) => ({ project: s.project, service: s.service, cpu: s.cpu, memory: s.memory }));
  const incoming = decls.map((d) => ({ project, service: d.name, cpu: d.cpu, memory: d.memory }));
  return [...others, ...incoming];
}

/** Run the admission check for a node and throw a readable error if it overflows. */
function assertCapacity(
  nodeId: string,
  node: NodeRegistryEntry,
  merged: CapacityServiceDemand[],
): void {
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
  rows.push(["── total", `${sharesToVcpu(result.usedCpu)} vCPU · ${result.usedMemory} MB`]);
  rows.push([
    "── allocatable",
    `${sharesToVcpu(result.allocatableCpu)} vCPU · ${result.allocatableMemory} MB`,
  ]);

  const over: string[] = [];
  if (result.cpuOverBy > 0) over.push(`${sharesToVcpu(result.cpuOverBy)} vCPU`);
  if (result.memoryOverBy > 0) over.push(`${result.memoryOverBy} MB`);

  throw new CliError(
    `node "${nodeId}" does not have enough capacity (over by ${over.join(" and ")})\n` +
      table(rows)
        .map((l) => `  ${l}`)
        .join("\n"),
    { hint: "reduce cpu/memory, move a service to another node, or use a larger instance type" },
  );
}

function printCapacitySummary(
  nodeId: string,
  node: NodeRegistryEntry,
  merged: CapacityServiceDemand[],
): void {
  if (isJsonMode()) return;
  const usedCpu = merged.reduce((s, x) => s + x.cpu, 0);
  const usedMemory = merged.reduce((s, x) => s + x.memory, 0);
  panel(`Node ${nodeId}`, [
    ...merged.map(
      (s) => `${color.cyan(`${s.project}/${s.service}`)}  ${sharesToVcpu(s.cpu)} vCPU · ${s.memory} MB`,
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
): Promise<DesiredState> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(nodeId));
    const state = existing ? parseDesiredState(existing.raw) : emptyDesiredState(nodeId, nowIso());
    const merged = mergeProjectServices(state.services, project, incoming);
    assertCapacity(nodeId, node, merged);

    const next: DesiredState = {
      version: PROTOCOL_VERSION,
      nodeId,
      updatedAt: nowIso(),
      services: merged,
    };

    try {
      await putJson(aws.s3, aws.bucket, desiredKey(nodeId), next, {
        ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }),
      });
      return next;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue; // re-read + retry
      throw error;
    }
  }
  throw new CliError(`could not publish desired state for node "${nodeId}"`, {
    hint: "another deploy may be racing this node — try again",
  });
}

async function runDeploy(opts: DeployOptions): Promise<void> {
  const { config, dir } = loadConfig();

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
    services = services.map((s) => ({ ...s, node: opts.node as string }));
  }

  const aws = await prepareAws(opts, { ensureBucket: true });
  log.step(`account ${color.cyan(aws.accountId)} · region ${color.cyan(aws.region)}`);
  log.step(`state bucket ${color.cyan(aws.bucket)}`);

  // Every referenced node must already exist in the registry.
  const nodeIds = [...new Set(services.map((s) => s.node))];
  const nodes = new Map<string, NodeRegistryEntry>();
  for (const id of nodeIds) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(id));
    if (!obj) {
      throw new CliError(`node "${id}" does not exist`, {
        hint: `create it first: launch-pad node create ${id}`,
      });
    }
    nodes.set(id, parseNodeRegistryEntry(obj.raw));
  }

  // Capacity pre-flight (from declared cpu/memory) BEFORE creating repos or building,
  // so a rejected deploy never leaves junk ECR repos behind.
  for (const id of nodeIds) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(id));
    const state = existing ? parseDesiredState(existing.raw) : emptyDesiredState(id, nowIso());
    const demands = capacityDemands(config.project, state, services.filter((s) => s.node === id));
    assertCapacity(id, node, demands);
    printCapacitySummary(id, node, demands);
  }

  // Ensure ECR repos + compute immutable tags.
  const built: BuiltService[] = [];
  for (const decl of services) {
    const repoName = ecrRepositoryName(config.project, decl.name);
    const repoUri = await ensureRepository(aws.ecr, repoName);
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
    });
  }

  if (opts.dryRun) {
    log.warn("dry run — no images pushed, no state written");
    if (isJsonMode()) {
      printJson({
        dryRun: true,
        services: built.map((b) => ({ service: b.decl.name, node: b.decl.node, image: b.image })),
      });
    }
    return;
  }

  // Build + push each service (skipping images already in ECR).
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
  for (const id of nodeIds) {
    const node = nodes.get(id) as NodeRegistryEntry;
    const incoming = built.filter((b) => b.decl.node === id).map((b) => toServiceConfig(config.project, b));
    await publishDesired(aws, id, node, config.project, incoming);
    log.success(`published desired state → ${color.cyan(id)}`);
  }

  const targets: WatchTarget[] = built.map((b) => ({
    nodeId: b.decl.node,
    project: config.project,
    service: b.decl.name,
    image: b.image,
  }));

  if (opts.wait === false) {
    reportPublished(built, config.project);
    return;
  }

  await watchAndReport(aws, targets, Number(opts.timeout ?? "180") * 1000, built);
}

function reportPublished(built: BuiltService[], project: string): void {
  if (isJsonMode()) {
    printJson({
      published: true,
      project,
      services: built.map((b) => ({ service: b.decl.name, node: b.decl.node, image: b.image })),
    });
    return;
  }
  panel("Published", [
    ...built.map((b) => `${color.cyan(`${project}/${b.decl.name}`)} ${color.dim("→")} ${b.decl.node}`),
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
  await waitForConvergence(aws.s3, aws.bucket, targets, timeoutMs, (results) => {
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
    if (r.ok) log.success(`${color.cyan(label)} running`);
    else log.warn(`${color.cyan(label)} ${color.dim(`(${r.state})`)} — ${r.message}`);
  }

  const webTargets = built.filter((b) => b.decl.domain);
  if (webTargets.length > 0) {
    panel(
      "URLs",
      webTargets.map((b) => `https://${b.decl.domain}`),
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
    .option("--no-wait", "don't wait for the agent to report convergence")
    .option("--timeout <seconds>", "how long to wait for convergence", "180")
    .option("--yes", "skip confirmation prompts")
    .option("--dry-run", "do everything except push images and write desired state")
    .addHelpText(
      "after",
      ["", "Examples:", "  $ launch-pad deploy", "  $ launch-pad deploy --service web --no-wait"].join("\n"),
    )
    .action(async (opts: DeployOptions) => {
      await runDeploy(opts);
    });

  applyGlobalOptions(cmd);
}
