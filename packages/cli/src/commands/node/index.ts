import { Command } from "commander";
import {
  agentIdForNode,
  DEFAULT_RESERVED_CPU,
  DEFAULT_RESERVED_MEMORY,
  desiredKey,
  HEARTBEAT_STALE_MS,
  type InstanceCapacity,
  INSTANCE_CAPACITY_TABLE,
  isHeartbeatStale,
  lookupInstanceCapacity,
  type NodeRegistryEntry,
  nodeRegistryKey,
  parseDesiredState,
  parseNodeRegistryEntry,
  parseNodeStatus,
  sharesToVcpu,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import {
  deleteSecurityGroup,
  describeInstanceIp,
  describeInstanceTypeCapacity,
  ensureEipForInstance,
  ensureSecurityGroup,
  getDefaultVpcId,
  releaseEip,
  runNode,
  startInstance,
  stopInstance,
  terminateInstance,
  waitForRunning,
} from "../../aws/ec2";
import { awsErrorName } from "../../aws/errors";
import { ensureInstanceProfile, ensureNodeRole, NODE_PROFILE_NAME, NODE_ROLE_NAME } from "../../aws/iam";
import {
  deleteObject,
  ensureBucket,
  getJson,
  listNodeIds,
  PreconditionFailedError,
  putJson,
} from "../../aws/s3-state";
import { resolveLatestAl2023Ami } from "../../aws/ssm";
import { CliError } from "../../errors";
import { applyGlobalOptions, type GlobalOpts } from "../../globals";
import { presignAgentBundle, uploadAgentBundle } from "../../provision/agent-bundle";
import { renderUserData } from "../../provision/user-data";
import { panel, table } from "../../ui/box";
import { isJsonMode, log, printJson, spinner } from "../../ui/log";
import { confirm } from "../../ui/prompt";
import { color, symbols } from "../../ui/theme";
import { readVersion } from "../../version";

function nowIso(): string {
  return new Date().toISOString();
}

function securityGroupName(nodeId: string): string {
  return `launch-pad-${nodeId}-sg`;
}

async function loadNode(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(nodeId));
  if (!obj) {
    throw new CliError(`node "${nodeId}" does not exist`, {
      hint: "list nodes with `launch-pad node list`",
    });
  }
  return parseNodeRegistryEntry(obj.raw);
}

async function resolveCapacity(aws: AwsEnv, instanceType: string): Promise<InstanceCapacity> {
  const fromTable = lookupInstanceCapacity(instanceType);
  if (fromTable) return fromTable;
  const fromApi = await describeInstanceTypeCapacity(aws.ec2, instanceType);
  if (fromApi) return fromApi;
  throw new CliError(`could not determine capacity for instance type "${instanceType}"`, {
    hint: `known types: ${Object.keys(INSTANCE_CAPACITY_TABLE).join(", ")}`,
  });
}

// ── create ─────────────────────────────────────────────────────────────────────

interface CreateOptions extends GlobalOpts {
  instanceType: string;
  keyName?: string;
  ami?: string;
  agentVersion?: string;
  yes?: boolean;
  dryRun?: boolean;
}

async function runCreate(name: string, opts: CreateOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const agentVersion = opts.agentVersion ?? readVersion();

  const capacity = await resolveCapacity(aws, opts.instanceType);
  const amiId = opts.ami ?? (await resolveLatestAl2023Ami(aws.ssm));
  const vpcId = await getDefaultVpcId(aws.ec2);

  const agentConfig = {
    nodeId: name,
    agentId: agentIdForNode(name),
    bucket: aws.bucket,
    region: aws.region,
  };

  if (opts.dryRun) {
    const userData = renderUserData({
      agent: agentConfig,
      bundleUrl: "https://<state-bucket>…/agent.cjs?<presigned-at-launch>",
    });
    printDryRun(name, opts, aws, capacity, amiId, vpcId, userData);
    return;
  }

  // Cost gate: launching an instance is billable + hard to undo.
  if (opts.yes !== true) {
    const ok = await confirm(
      `launch a ${color.cyan(opts.instanceType)} EC2 instance in ${color.cyan(aws.region)} (billed hourly) and register node "${name}"?`,
      false,
    );
    if (!ok) {
      throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
    }
  }

  await ensureBucket(aws.s3, aws.bucket, aws.region);

  const existing = await getJson(aws.s3, aws.bucket, nodeRegistryKey(name));
  if (existing) {
    throw new CliError(`node "${name}" already exists`, {
      hint: "pick another name or `launch-pad node destroy` it first",
    });
  }

  const spin = spinner("provisioning…").start();
  try {
    spin.text = "uploading agent bundle";
    await uploadAgentBundle(aws.s3, aws.bucket, name);
    const bundleUrl = await presignAgentBundle(aws.s3, aws.bucket, name);
    const userData = renderUserData({ agent: agentConfig, bundleUrl });

    spin.text = "ensuring IAM role + instance profile";
    await ensureNodeRole(aws.iam, aws.bucket, aws.region, aws.accountId);
    const profileName = await ensureInstanceProfile(aws.iam);

    spin.text = "ensuring security group";
    const sgId = await ensureSecurityGroup(aws.ec2, securityGroupName(name), vpcId, {
      ssh: opts.keyName !== undefined,
    });

    spin.text = `launching ${opts.instanceType}`;
    const instanceId = await runNode(aws.ec2, {
      imageId: amiId,
      instanceType: opts.instanceType,
      userData,
      securityGroupId: sgId,
      instanceProfileName: profileName,
      nodeId: name,
      ...(opts.keyName ? { keyName: opts.keyName } : {}),
    });

    spin.text = `waiting for ${instanceId} to start`;
    let network = { publicIp: null as string | null, availabilityZone: null as string | null };
    try {
      network = await waitForRunning(aws.ec2, instanceId);
    } catch {
      spin.warn(`instance ${instanceId} launched but did not reach 'running' in time`);
    }

    // Give the node a stable Elastic IP so its address survives stop/start (pause).
    spin.text = "assigning a stable Elastic IP";
    const eip = await ensureEipForInstance(aws.ec2, name, instanceId);

    const entry: NodeRegistryEntry = {
      nodeId: name,
      instanceId,
      instanceType: opts.instanceType,
      region: aws.region,
      availabilityZone: network.availabilityZone,
      totalCpu: capacity.totalCpu,
      totalMemory: capacity.totalMemory,
      reservedCpu: DEFAULT_RESERVED_CPU,
      reservedMemory: DEFAULT_RESERVED_MEMORY,
      publicIp: eip.publicIp,
      eipAllocationId: eip.allocationId,
      securityGroupId: sgId,
      iamInstanceProfile: profileName,
      agentId: agentIdForNode(name),
      agentVersion,
      createdAt: nowIso(),
      createdBy: aws.callerArn,
      state: "provisioning",
    };

    try {
      await putJson(aws.s3, aws.bucket, nodeRegistryKey(name), entry, { ifNoneMatch: "*" });
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new CliError(`node "${name}" already exists`);
      }
      throw error;
    }

    if (spin.isSpinning) spin.succeed(`launched node ${color.cyan(name)} (${instanceId})`);
    reportCreated(entry);
  } catch (error) {
    if (spin.isSpinning) spin.fail("provisioning failed");
    throw error;
  }
}

function reportCreated(entry: NodeRegistryEntry): void {
  if (isJsonMode()) {
    printJson(entry);
    return;
  }
  panel(`Node ${entry.nodeId}`, [
    ...table([
      ["instance", entry.instanceId ?? color.yellow("pending")],
      ["instance type", entry.instanceType],
      ["region / az", `${entry.region} ${color.dim(entry.availabilityZone ?? "")}`],
      ["elastic ip", entry.publicIp ?? color.yellow("pending")],
      ["capacity", `${sharesToVcpu(entry.totalCpu)} vCPU · ${entry.totalMemory} MB`],
    ]),
    "",
    color.dim("the agent installs on boot and reconciles desired state from S3."),
    ...(entry.publicIp
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
  vpcId: string,
  userData: string,
): void {
  if (isJsonMode()) {
    printJson({
      dryRun: true,
      node: name,
      region: aws.region,
      instanceType: opts.instanceType,
      capacity,
      amiId,
      vpcId,
      securityGroup: securityGroupName(name),
      iamRole: NODE_ROLE_NAME,
      instanceProfile: NODE_PROFILE_NAME,
      ssh: opts.keyName !== undefined,
      userData,
    });
    return;
  }
  panel(`Plan for node ${name} ${color.dim("(dry run — nothing created)")}`, [
    ...table([
      ["region", aws.region],
      ["instance type", `${opts.instanceType} ${color.dim(`(${sharesToVcpu(capacity.totalCpu)} vCPU · ${capacity.totalMemory} MB)`)}`],
      ["ami", amiId],
      ["vpc", vpcId],
      ["security group", `${securityGroupName(name)} ${color.dim(opts.keyName ? "(80/443/22)" : "(80/443)")}`],
      ["iam role", NODE_ROLE_NAME],
      ["instance profile", NODE_PROFILE_NAME],
    ]),
  ]);
  log.plain(color.dim("  ── generated bootstrap (user_data) ──"));
  for (const line of userData.split("\n")) log.dim(`  ${line}`);
  log.plain();
}

// ── list ─────────────────────────────────────────────────────────────────────

async function safeListNodeIds(aws: AwsEnv): Promise<string[]> {
  try {
    return await listNodeIds(aws.s3, aws.bucket);
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
}

async function usedCapacity(aws: AwsEnv, nodeId: string): Promise<{ cpu: number; memory: number }> {
  const obj = await getJson(aws.s3, aws.bucket, desiredKey(nodeId));
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
  const obj = await getJson(aws.s3, aws.bucket, statusKey(nodeId));
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

  const entries: NodeRegistryEntry[] = [];
  for (const id of ids) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(id));
    if (obj) {
      try {
        entries.push(parseNodeRegistryEntry(obj.raw));
      } catch {
        /* skip malformed entries */
      }
    }
  }

  if (isJsonMode()) {
    printJson(entries);
    return;
  }
  if (entries.length === 0) {
    log.info("no nodes registered yet");
    log.dim("  create one with `launch-pad node create <name>`");
    return;
  }

  log.plain();
  for (const node of entries) {
    const used = await usedCapacity(aws, node.nodeId);
    const beat = await heartbeat(aws, node.nodeId);
    const where = node.instanceId
      ? `${color.dim(node.instanceId)} ${node.publicIp ?? ""}`.trim()
      : color.yellow("not provisioned");
    log.plain(`  ${color.cyan(node.nodeId)}  ${color.dim(node.instanceType)}  ${beat}  ${where}`);
    log.plain(
      `    ${color.dim(
        `cpu ${sharesToVcpu(used.cpu)}/${sharesToVcpu(node.totalCpu - node.reservedCpu)} vCPU · ` +
          `mem ${used.memory}/${node.totalMemory - node.reservedMemory} MB · ${node.region}`,
      )}`,
    );
  }
  log.plain();
}

// ── show ─────────────────────────────────────────────────────────────────────

async function runShow(name: string, opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);

  // Refresh the public IP (it can change across stop/start).
  let publicIp = node.publicIp;
  if (node.instanceId) {
    publicIp = (await describeInstanceIp(aws.ec2, node.instanceId)) ?? node.publicIp;
  }

  const desired = await getJson(aws.s3, aws.bucket, desiredKey(name));
  const status = await getJson(aws.s3, aws.bucket, statusKey(name));

  if (isJsonMode()) {
    printJson({ node: { ...node, publicIp }, desired: desired?.raw ?? null, status: status?.raw ?? null });
    return;
  }

  panel(`Node ${name}`, [
    ...table([
      ["instance", node.instanceId ?? color.yellow("not provisioned")],
      ["instance type", node.instanceType],
      ["region / az", `${node.region} ${color.dim(node.availabilityZone ?? "")}`],
      ["public ip", publicIp ?? color.dim("—")],
      ["security group", node.securityGroupId ?? color.dim("—")],
      ["capacity", `${sharesToVcpu(node.totalCpu)} vCPU · ${node.totalMemory} MB`],
      ["state", node.state],
      ["created", `${node.createdAt} ${color.dim(`by ${node.createdBy}`)}`],
    ]),
  ]);

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
}

async function runDestroy(name: string, opts: DestroyOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);

  const desired = await getJson(aws.s3, aws.bucket, desiredKey(name));
  let serviceCount = 0;
  if (desired) {
    try {
      serviceCount = parseDesiredState(desired.raw).services.length;
    } catch {
      serviceCount = 0;
    }
  }

  if (opts.yes !== true) {
    if (serviceCount > 0) {
      log.warn(`node "${name}" still has ${serviceCount} scheduled service(s) — they will be orphaned`);
    }
    const what = node.instanceId ? `terminate instance ${node.instanceId} and destroy` : "destroy";
    const ok = await confirm(`${what} node "${name}"?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const spin = spinner("tearing down…").start();
  try {
    if (node.instanceId) {
      spin.text = `terminating ${node.instanceId}`;
      await terminateInstance(aws.ec2, node.instanceId);
    }
    if (node.eipAllocationId) {
      spin.text = "releasing Elastic IP";
      try {
        await releaseEip(aws.ec2, node.eipAllocationId);
      } catch (error) {
        spin.warn(`could not release Elastic IP ${node.eipAllocationId}: ${(error as Error).message}`);
        spin.start();
      }
    }
    if (node.securityGroupId) {
      spin.text = "deleting security group";
      try {
        await deleteSecurityGroup(aws.ec2, node.securityGroupId);
      } catch (error) {
        spin.warn(`could not delete security group ${node.securityGroupId}: ${(error as Error).message}`);
        spin.start();
      }
    }
    spin.text = "removing registry entry";
    for (const key of [statusKey(name), desiredKey(name), nodeRegistryKey(name)]) {
      await deleteObject(aws.s3, aws.bucket, key);
    }
    if (spin.isSpinning) spin.succeed(`destroyed node ${color.cyan(name)}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("teardown failed");
    throw error;
  }

  if (isJsonMode()) printJson({ destroyed: name });
}

// ── pause / resume (save money) ──────────────────────────────────────────────────

async function runPause(name: string, opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);
  if (!node.instanceId) {
    throw new CliError(`node "${name}" has no instance to pause`);
  }

  const spin = spinner(`pausing ${name} (stopping ${node.instanceId})…`).start();
  try {
    await stopInstance(aws.ec2, node.instanceId);
    await putJson(aws.s3, aws.bucket, nodeRegistryKey(name), { ...node, state: "stopped" });
    spin.succeed(`paused node ${color.cyan(name)}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("pause failed");
    throw error;
  }

  if (isJsonMode()) {
    printJson({ paused: name });
    return;
  }
  log.dim("  compute billing stops; the Elastic IP + EBS volume still incur a small charge");
  log.dim(`  resume with: ${color.cyan(`launch-pad node resume ${name}`)}`);
}

async function runResume(name: string, opts: GlobalOpts): Promise<void> {
  const aws = await prepareAws(opts);
  const node = await loadNode(aws, name);
  if (!node.instanceId) {
    throw new CliError(`node "${name}" has no instance to resume`);
  }

  const spin = spinner(`resuming ${name} (starting ${node.instanceId})…`).start();
  try {
    const net = await startInstance(aws.ec2, node.instanceId);
    // An Elastic IP stays associated across stop/start, so the address is stable.
    const publicIp = node.eipAllocationId ? node.publicIp : net.publicIp;
    await putJson(aws.s3, aws.bucket, nodeRegistryKey(name), {
      ...node,
      state: "ready",
      publicIp,
      availabilityZone: net.availabilityZone,
    });
    spin.succeed(`resumed node ${color.cyan(name)} at ${publicIp ?? "?"}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail("resume failed");
    throw error;
  }

  if (isJsonMode()) {
    printJson({ resumed: name });
    return;
  }
  if (!node.eipAllocationId) {
    log.warn("this node has no Elastic IP, so its public IP may have changed — re-check `node show`");
  }
}

// ── registration ────────────────────────────────────────────────────────────────

export function registerNode(program: Command): void {
  const node = program
    .command("node")
    .description("Manage launch-pad nodes — the machines that run your services");

  const create = node
    .command("create <name>")
    .description("Provision an EC2 node, install the agent, and register it")
    .option("--instance-type <type>", "EC2 instance type", "t3.small")
    .option("--key-name <keypair>", "EC2 key pair for SSH (omit to disable SSH)")
    .option("--ami <id>", "AMI id (default: latest Amazon Linux 2023)")
    .option("--agent-version <semver>", "agent version to install (default: this CLI's version)")
    .option("--dry-run", "show the provisioning plan + bootstrap without creating anything")
    .option("--yes", "skip the launch confirmation prompt")
    .action(async (name: string, opts: CreateOptions) => {
      await runCreate(name, opts);
    });
  applyGlobalOptions(create);

  const list = node
    .command("list")
    .description("List registered nodes and their capacity / heartbeat")
    .action(async (opts: GlobalOpts) => {
      await runList(opts);
    });
  applyGlobalOptions(list);

  const show = node
    .command("show <name>")
    .description("Show a node's registry entry, desired state, and status")
    .action(async (name: string, opts: GlobalOpts) => {
      await runShow(name, opts);
    });
  applyGlobalOptions(show);

  const destroy = node
    .command("destroy <name>")
    .description("Terminate the node's instance, release its IP, and deregister it")
    .option("--yes", "skip confirmation prompts")
    .action(async (name: string, opts: DestroyOptions) => {
      await runDestroy(name, opts);
    });
  applyGlobalOptions(destroy);

  const pause = node
    .command("pause <name>")
    .description("Stop the node's instance to save money (keeps its Elastic IP + disk)")
    .action(async (name: string, opts: GlobalOpts) => {
      await runPause(name, opts);
    });
  applyGlobalOptions(pause);

  const resume = node
    .command("resume <name>")
    .description("Start a paused node back up")
    .action(async (name: string, opts: GlobalOpts) => {
      await runResume(name, opts);
    });
  applyGlobalOptions(resume);
}
