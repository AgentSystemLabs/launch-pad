import { setTimeout as sleep } from "node:timers/promises";
import {
  agentIdForNode,
  DEFAULT_RESERVED_CPU,
  DEFAULT_RESERVED_MEMORY,
  generateNodeName,
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  type NodeRegistryEntry,
  type NodeRole,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  parseNodeStatus,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import { deleteExternalNodeIam, ensureExternalNodeIam } from "../../aws/iam";
import { deleteObject, getJson, listNodeIds, PreconditionFailedError, putJson } from "../../aws/s3-state";
import { adoptEdgeIfUnset } from "../../cluster/store";
import { CliError } from "../../errors";
import type { GlobalOpts } from "../../globals";
import { uploadAndPresignAgent } from "../../provision/agent-bundle";
import {
  AGENT_ENV_FILE,
  renderExternalBootstrap,
} from "../../provision/external-bootstrap";
import {
  REACHABILITY_SAMPLE_PORT,
  probeEdgeReachability,
  renderTemporaryListenerScript,
} from "../../provision/reachability";
import { parseSshHost, sshCaptureCommand, sshPreflight, sshRunScript, type SshTarget } from "../../provision/ssh";
import { renderSystemdUnit } from "../../provision/systemd-unit";
import { panel, table } from "../../ui/box";
import { isJsonMode, log, printJson, spinner } from "../../ui/log";
import { confirm } from "../../ui/prompt";
import { color } from "../../ui/theme";
import { assertValidNodeId } from "../../validate-node-id";

/** What `launchpad node init` accepts (BYOS external node enrollment, Phase 1 = app only). */
export interface InitOptions extends GlobalOpts {
  host: string;
  role: string;
  edge?: string;
  advertiseIp?: string;
  publicIp?: string;
  cpu: string;
  memory: string;
  name?: string;
  sshKey?: string;
  sshPort?: string;
  agentVersion?: string;
  timeout?: string;
  yes?: boolean;
  dryRun?: boolean;
  showSecrets?: boolean;
}

const REDACTED = "***";
export const DETECT_ADVERTISE_IP_COMMAND =
  "ip -o -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i==\"src\") {print $(i+1); exit}}'";

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const n = Number(part);
      return n >= 0 && n <= 255 && part === String(n);
    })
  );
}

export function parseDetectedAdvertiseIp(output: string): string | null {
  for (const token of output.split(/\s+/)) {
    const ip = token.trim();
    if (isIpv4Address(ip) && !ip.startsWith("127.")) return ip;
  }
  return null;
}

async function detectAdvertiseIp(target: SshTarget): Promise<string> {
  const output = await sshCaptureCommand(target, DETECT_ADVERTISE_IP_COMMAND);
  const ip = parseDetectedAdvertiseIp(output);
  if (!ip) {
    throw new CliError("could not auto-detect --advertise-ip over SSH", {
      hint: "pass --advertise-ip explicitly with an address reachable from the edge",
    });
  }
  return ip;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a `--cpu`/`--memory` value to a positive integer, else a CliError. */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(`invalid ${flag} "${raw}"`, { hint: `pass a positive integer, e.g. ${flag} 2048` });
  }
  return n;
}

/**
 * Build the registry entry for an external (BYOS) node. PURE — no AWS/S3. The EC2-specific
 * fields are all null (no instance, no security group, no instance profile, no Elastic IP);
 * `provisioning` is "external" and the edge dials `advertiseIp` instead of a VPC privateIp.
 * Host reservation matches the EC2 path exactly (the same `DEFAULT_RESERVED_*` constants),
 * so capacity admission treats an external app node like any other.
 */
export function buildExternalNodeEntry(args: {
  aws: AwsEnv;
  nodeId: string;
  role: NodeRole;
  cpu: number;
  memory: number;
  advertiseIp: string | null;
  publicIp: string | null;
  iamUserName: string;
  agentVersion: string | null;
}): NodeRegistryEntry {
  return {
    nodeId: args.nodeId,
    clusterId: args.aws.clusterId,
    instanceId: null,
    instanceType: "external",
    architecture: "x86_64",
    region: args.aws.region,
    availabilityZone: null,
    role: args.role,
    privateIp: null,
    totalCpu: args.cpu,
    totalMemory: args.memory,
    reservedCpu: DEFAULT_RESERVED_CPU,
    reservedMemory: DEFAULT_RESERVED_MEMORY,
    // App nodes are VPC-private on EC2, but a BYOS app host may be directly reachable —
    // surface its advertiseIp as the public ip when no explicit --public-ip is given.
    publicIp: args.role === "app" ? (args.publicIp ?? args.advertiseIp) : args.publicIp,
    eipAllocationId: null,
    securityGroupId: null,
    iamInstanceProfile: null,
    provisioning: "external",
    advertiseIp: args.advertiseIp,
    iamUserName: args.iamUserName,
    agentId: agentIdForNode(args.nodeId),
    agentVersion: args.agentVersion,
    agentType: "rust",
    createdAt: nowIso(),
    createdBy: args.aws.callerArn,
    state: "provisioning",
  };
}

export function canResumeExternalInit(entry: NodeRegistryEntry): boolean {
  return entry.provisioning === "external" && entry.state === "provisioning";
}

/** A node.json view safe to print/log: never expose the IAM access key material. */
function summaryFor(
  entry: NodeRegistryEntry,
  creds: { accessKeyId: string; secretAccessKey: string } | null,
  showSecrets: boolean,
): Record<string, unknown> {
  return {
    node: entry,
    iam: creds
      ? {
          userName: entry.iamUserName,
          accessKeyId: showSecrets ? creds.accessKeyId : REDACTED,
          secretAccessKey: showSecrets ? creds.secretAccessKey : REDACTED,
        }
      : { userName: entry.iamUserName },
  };
}

/**
 * Enroll an operator-owned server as an external (BYOS) app node. We mint a per-node IAM
 * user + access key (the node's only credentials), upload the role's agent binary, then SSH
 * in and run a bash bootstrap that writes the credentials to a chmod-600 EnvironmentFile,
 * drops the agent + systemd unit, and starts it. No EC2 is ever touched. Once the node's
 * agent posts a fresh heartbeat to S3 we flip its registry state to "ready".
 */
export async function runInit(opts: InitOptions): Promise<void> {
  const aws = await prepareAws(opts, { ensureBucket: true });

  // (b) role — external app nodes run Docker; external edge nodes run Caddy only.
  if (opts.role !== "app" && opts.role !== "edge") {
    throw new CliError(`invalid --role "${opts.role}" (expected app or edge)`, {
      hint: "external (BYOS) nodes support --role app or --role edge",
    });
  }
  const role: NodeRole = opts.role;

  // (c) host + capacity + edge + advertiseIp.
  if (!opts.host || opts.host.trim().length === 0) {
    throw new CliError("--host is required", { hint: "e.g. --host ubuntu@203.0.113.10" });
  }
  const sshTarget = parseSshHost(opts.host.trim());
  if (sshTarget.host.length === 0) {
    throw new CliError(`invalid --host "${opts.host}"`, { hint: "expected user@host or host" });
  }
  const ssh: SshTarget = {
    host: sshTarget.host,
    user: sshTarget.user,
    port: Number(opts.sshPort) || undefined,
    key: opts.sshKey,
  };
  const cpu = parsePositiveInt(opts.cpu, "--cpu");
  const memory = parsePositiveInt(opts.memory, "--memory");

  let edge: NodeRegistryEntry | null = null;
  if (role === "app") {
    if (!opts.edge || opts.edge.trim().length === 0) {
      throw new CliError("--edge is required for an external app node", {
        hint: "name the cluster's edge node, e.g. --edge edge-1",
      });
    }
    assertValidNodeId(opts.edge);
    edge = await loadNodeOrNull(aws, opts.edge);
    if (!edge) {
      throw new CliError(`edge node "${opts.edge}" does not exist in cluster "${aws.clusterId}"`, {
        hint: "list nodes with `launchpad node list`, or create the edge first",
      });
    }
    if (edge.role !== "edge") {
      throw new CliError(`node "${opts.edge}" is role "${edge.role}", not an edge`, {
        hint: "an external app node routes through the cluster's edge — pass the edge's node id",
      });
    }
  } else if (opts.edge) {
    throw new CliError("--edge only applies to external app nodes", {
      hint: "an external edge node is itself the router; omit --edge",
    });
  }

  let preflightChecked = false;
  let advertiseIp = role === "app" ? opts.advertiseIp?.trim() : undefined;
  if (role === "app" && !advertiseIp && !opts.dryRun) {
    await sshPreflight(ssh);
    preflightChecked = true;
    const detected = await detectAdvertiseIp(ssh);
    if (opts.yes !== true) {
      const ok = await confirm(
        `use detected advertise IP ${color.cyan(detected)} for ${color.cyan(opts.host)}?`,
        true,
      );
      if (!ok) {
        throw new CliError("aborted", {
          hint: "re-run with --advertise-ip <ip> to choose a different address",
        });
      }
    }
    advertiseIp = detected;
  }
  const publicIp = opts.publicIp?.trim() || null;
  if (role === "edge" && !publicIp) {
    throw new CliError("--public-ip is required for an external edge node", {
      hint: "the stable public IP users point DNS at (ports 80/443 must reach this host)",
    });
  }

  // (d) node id — explicit --name or a generated <noun>-<verb>-<adverb>, unique in the cluster.
  const existingIds = await listNodeIds(aws.s3, aws.bucket, aws.clusterId);
  const nodeId = opts.name ?? generateNodeName(existingIds);
  assertValidNodeId(nodeId);
  const existing = await loadNodeOrNull(aws, nodeId);
  if (existing) {
    if (opts.name && canResumeExternalInit(existing)) {
      await resumeExternalInit(aws, existing, opts, edge, sshTarget);
      return;
    }
    throw new CliError(`node "${nodeId}" is already enrolled in cluster "${aws.clusterId}"`, {
      hint:
        existing.provisioning === "external" && existing.state === "ready"
          ? "the BYOS node is already ready; use `launchpad node show` or `launchpad node upgrade-agent`"
          : "use `launchpad node upgrade-agent` to update it, or pick another --name",
    });
  }

  const agentVersion = opts.agentVersion ?? null;

  // (e) the agent.json written to /etc/launch-pad/agent.json on the host.
  const agentConfig = {
    nodeId,
    agentId: agentIdForNode(nodeId),
    bucket: aws.bucket,
    region: aws.region,
    clusterId: aws.clusterId,
    role,
    ...(advertiseIp ? { advertiseIp } : {}),
  };
  const agentConfigJson = JSON.stringify(agentConfig, null, 2);

  // (f) the registry entry (state "provisioning"; iamUserName filled in after we mint it).
  const entry = buildExternalNodeEntry({
    aws,
    nodeId,
    role,
    cpu,
    memory,
    advertiseIp: advertiseIp ?? null,
    publicIp,
    iamUserName: "",
    agentVersion,
  });

  // (g) dry run — show the plan, touch nothing, redact secrets (there are none yet).
  if (opts.dryRun) {
    const plan = {
      dryRun: true,
      cluster: aws.clusterId,
      region: aws.region,
      node: nodeId,
      role,
      provisioning: "external" as const,
      ec2: "not touched (BYOS — you own the server)",
      iamUser: `will create IAM user + access key (shown only on creation)`,
      ssh: {
        host: sshTarget.host,
        user: sshTarget.user ?? null,
        port: opts.sshPort ? Number(opts.sshPort) : null,
        steps: [
          "detect package manager (dnf | apt-get)",
          role === "app"
            ? advertiseIp
              ? "use the provided --advertise-ip"
              : "auto-detect --advertise-ip over SSH on apply"
            : "record the stable --public-ip for DNS",
          role === "app" ? "install Docker (app role)" : "install Caddy (edge role)",
          "write /etc/launch-pad/agent.env (chmod 600) + agent.json (chmod 600)",
          "fetch the agent binary and install the systemd unit",
          "systemctl enable --now launch-pad-agent",
        ],
      },
    advertiseIp: advertiseIp ?? null,
      edge: opts.edge,
      entry,
    };
    if (isJsonMode()) {
      printJson(plan);
      return;
    }
    panel(`Plan for external node ${nodeId} ${color.dim("(dry run — nothing created)")}`, [
      ...table([
        ["cluster", aws.clusterId],
        ["region", aws.region],
        ["role", role],
        ["provisioning", "external (BYOS)"],
        ["ssh", `${opts.host}${opts.sshPort ? ` :${opts.sshPort}` : ""}`],
        ["advertise ip", advertiseIp ?? color.dim("—")],
        ["edge", role === "app" ? (opts.edge ?? color.dim("—")) : color.dim("self")],
        ...(role === "edge" ? ([["public ip", publicIp ?? color.dim("—")]] as Array<[string, string]>) : []),
        ["capacity", `${cpu} shares · ${memory} MB`],
        ["iam", "creates a per-node IAM user + access key on apply"],
        ["ec2", color.dim("not touched — you own the server")],
      ]),
      "",
      color.dim(
        role === "app"
          ? "bootstrap will: install Docker, write credentials + agent config, install + start the agent."
          : "bootstrap will: install Caddy, write credentials + agent config, install + start the edge agent.",
      ),
    ]);
    return;
  }

  // (h) confirm — this mints a real IAM user/access key and SSHes into the host as root.
  if (opts.yes !== true) {
    const ok = await confirm(
      `enroll ${color.cyan(opts.host)} as external ${role} node ${color.cyan(nodeId)} — create an IAM user + access key and SSH in to install the agent?`,
      false,
    );
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  const spin = spinner(`enrolling ${color.cyan(nodeId)}…`).start();
  let creds: { accessKeyId: string; secretAccessKey: string } | null = null;
  // Once node.json is written, node destroy can find and clean up the per-node IAM user.
  // If bootstrap fails before the host is live, we still best-effort roll both back.
  let registryEtag: string | null = null;
  let bootstrapped = false;
  try {
    spin.text = `checking SSH + passwordless sudo on ${sshTarget.host}`;
    if (!preflightChecked) await sshPreflight(ssh);

    // (i) mint the per-node IAM user + access key.
    spin.text = "creating IAM user + access key";
    const iam = await ensureExternalNodeIam(aws.iam, {
      clusterId: aws.clusterId,
      nodeId,
      role,
      bucket: aws.bucket,
      region: aws.region,
      accountId: aws.accountId,
    });
    creds = { accessKeyId: iam.accessKeyId, secretAccessKey: iam.secretAccessKey };
    entry.iamUserName = iam.userName;

    // (j) register the provisioning node BEFORE bootstrap. This removes the old
    // post-bootstrap/pre-register failure window where a live BYOS host had credentials
    // but no node.json for `node destroy` to discover and clean up.
    spin.text = "registering node";
    try {
      registryEtag = await putJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId), entry, {
        ifNoneMatch: "*",
      });
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw new CliError(`node "${nodeId}" was registered concurrently`, {
          hint: "re-run with a different --name",
        });
      }
      throw error;
    }

    // (k) upload the role's agent binary and presign its fetch URL.
    spin.text = "uploading agent binary";
    const presignedUrl = await uploadAndPresignAgent(
      aws.s3,
      aws.bucket,
      aws.clusterId,
      nodeId,
      role,
      entry.architecture,
    );

    // (l) systemd unit pointing at the EnvironmentFile (so the agent reads agent.env creds).
    const unit = renderSystemdUnit(role, { environmentFile: AGENT_ENV_FILE });

    // (m) render the bootstrap (contains the secret — never logged).
    const script = renderExternalBootstrap({
      role,
      agentConfigJson,
      agentBinaryUrl: presignedUrl,
      systemdUnit: unit,
      architecture: entry.architecture,
      aws: {
        accessKeyId: iam.accessKeyId,
        secretAccessKey: iam.secretAccessKey,
        region: aws.region,
      },
    });

    // (n) SSH in and run it (stream remote output; the script itself is never logged).
    spin.text = `running bootstrap on ${sshTarget.host}`;
    if (spin.isSpinning) spin.stop();
    await sshRunScript(
      ssh,
      script,
      (line) => log.dim(`  ${line}`),
    );
    bootstrapped = true;
    spin.start();
    if (role === "edge") {
      try {
        await adoptEdgeIfUnset(aws, aws.clusterId, nodeId);
      } catch {
        log.warn(`could not set ${nodeId} as the cluster default edge — use \`launchpad cluster set-edge ${aws.clusterId} ${nodeId}\``);
      }
    }
    if (spin.isSpinning) spin.succeed(`enrolled external node ${color.cyan(nodeId)}`);
  } catch (error) {
    if (spin.isSpinning) spin.fail(`enrolling ${nodeId} failed`);
    // Roll back the per-node IAM user only while the host hasn't fully bootstrapped.
    // If rollback of node.json fails, `node destroy` can still use it to clean up.
    if (creds && !bootstrapped) {
      try {
        await deleteExternalNodeIam(aws.iam, aws.clusterId, nodeId);
        log.dim(`  rolled back the IAM user for ${nodeId}`);
      } catch {
        log.warn(`could not roll back the IAM user for ${nodeId} — remove it manually if it persists`);
      }
      if (registryEtag) {
        try {
          await deleteObject(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId), {
            ifMatch: registryEtag,
          });
          log.dim(`  rolled back the registry entry for ${nodeId}`);
        } catch {
          log.warn(`could not roll back node.json for ${nodeId} — use \`launchpad node destroy ${nodeId}\``);
        }
      }
    }
    throw error;
  }

  // (o) wait for the agent's first heartbeat, then flip state → ready.
  const timeoutMs = (Number(opts.timeout) || 180) * 1000;
  const ready = await waitForFirstHeartbeat(aws, nodeId, timeoutMs);
  let finalState: NodeRegistryEntry["state"] = entry.state;
  if (ready) {
    finalState = await markReady(aws, nodeId);
  }

  const reachability =
    role === "app" && edge && advertiseIp
      ? await checkAppReachability(aws, edge, nodeId, advertiseIp, sshTarget, opts)
      : null;

  // (p) summary.
  if (isJsonMode()) {
    printJson({
      ...summaryFor({ ...entry, state: finalState }, creds, opts.showSecrets === true),
      ready,
      reachability,
    });
    return;
  }
  const rows: Array<[string, string]> = [
    ["cluster", aws.clusterId],
    ["region", aws.region],
    ["role", role],
    ["provisioning", "external (BYOS)"],
    ["advertise ip", advertiseIp ?? color.dim("—")],
    ["edge", role === "app" ? (opts.edge ?? color.dim("—")) : color.dim("self")],
    ...(role === "edge" ? ([["public ip", publicIp ?? color.dim("—")]] as Array<[string, string]>) : []),
    ["iam user", entry.iamUserName],
    ["state", ready ? color.green("ready") : color.yellow("provisioning")],
  ];
  panel(`External node ${nodeId}`, [...table(rows)]);
  if (!ready) {
    log.warn(
      `the agent on ${opts.host} has not posted a heartbeat yet (waited ${Math.round(timeoutMs / 1000)}s)`,
    );
    log.dim("  check the box (`systemctl status launch-pad-agent`, `journalctl -u launch-pad-agent`),");
    log.dim(`  then re-run the same \`launchpad node init\` command with \`--name ${nodeId}\` to resume the wait.`);
    log.dim(`  \`launchpad node destroy ${nodeId}\` cleans up the IAM user + registry entry.`);
  } else {
    log.success(`node ${color.cyan(nodeId)} is live and reconciling desired state`);
  }
  if (reachability) {
    if (reachability.ok) {
      log.success(
        `edge ${color.cyan(opts.edge)} can reach ${color.cyan(advertiseIp)}:${REACHABILITY_SAMPLE_PORT}`,
      );
    } else {
      log.warn(
        `edge ${opts.edge} could not verify ${advertiseIp}:${REACHABILITY_SAMPLE_PORT} — ${reachability.detail}`,
      );
      log.dim("  open the edge → BYOS host path for TCP 20000-29999 before deploying web services.");
    }
  }
}

async function checkAppReachability(
  aws: AwsEnv,
  edge: NodeRegistryEntry,
  nodeId: string,
  advertiseIp: string,
  sshTarget: { user?: string; host: string },
  opts: InitOptions,
): Promise<Awaited<ReturnType<typeof probeEdgeReachability>>[number]> {
  try {
    await sshRunScript(
      { host: sshTarget.host, user: sshTarget.user, port: Number(opts.sshPort) || undefined, key: opts.sshKey },
      renderTemporaryListenerScript(REACHABILITY_SAMPLE_PORT),
      () => {},
    );
    return (
      (await probeEdgeReachability(aws, edge, [
        { nodeId, advertiseIp, ports: [REACHABILITY_SAMPLE_PORT] },
      ]))[0] ?? {
        nodeId,
        advertiseIp,
        ports: [REACHABILITY_SAMPLE_PORT],
        ok: false,
        detail: "probe returned no result",
      }
    );
  } catch (error) {
    return {
      nodeId,
      advertiseIp,
      ports: [REACHABILITY_SAMPLE_PORT],
      ok: false,
      detail: `probe skipped: ${(error as Error).message}`,
    };
  }
}

async function resumeExternalInit(
  aws: AwsEnv,
  entry: NodeRegistryEntry,
  opts: InitOptions,
  edge: NodeRegistryEntry | null,
  sshTarget: { user?: string; host: string },
): Promise<void> {
  const timeoutMs = (Number(opts.timeout) || 180) * 1000;
  const spin = isJsonMode() ? null : spinner(`resuming enrollment for ${color.cyan(entry.nodeId)}…`).start();
  const ready = await waitForFirstHeartbeat(aws, entry.nodeId, timeoutMs);
  let finalState: NodeRegistryEntry["state"] = entry.state;
  if (ready) {
    finalState = await markReady(aws, entry.nodeId);
  }
  if (spin?.isSpinning) {
    spin.succeed(
      ready ? `external node ${color.cyan(entry.nodeId)} is ready` : `external node ${color.cyan(entry.nodeId)} still waiting for heartbeat`,
    );
  }

  const advertiseIp = entry.advertiseIp ?? opts.advertiseIp?.trim();
  const reachability =
    entry.role === "app" && edge && advertiseIp
      ? await checkAppReachability(aws, edge, entry.nodeId, advertiseIp, sshTarget, opts)
      : null;

  if (isJsonMode()) {
    printJson({
      ...summaryFor({ ...entry, state: finalState }, null, false),
      resumed: true,
      ready,
      reachability,
    });
    return;
  }

  panel(`External node ${entry.nodeId}`, [
    ...table([
      ["cluster", aws.clusterId],
      ["region", aws.region],
      ["role", entry.role],
      ["provisioning", "external (BYOS)"],
      ["advertise ip", advertiseIp ?? color.dim("—")],
      ["edge", entry.role === "app" ? (opts.edge ?? color.dim("—")) : color.dim("self")],
      ...(entry.role === "edge" ? ([["public ip", entry.publicIp ?? color.dim("—")]] as Array<[string, string]>) : []),
      ["iam user", entry.iamUserName ?? color.dim("—")],
      ["state", ready ? color.green("ready") : color.yellow("provisioning")],
    ]),
  ]);
  if (!ready) {
    log.warn(
      `the agent on ${opts.host} has not posted a heartbeat yet (waited ${Math.round(timeoutMs / 1000)}s)`,
    );
    log.dim("  check the box (`systemctl status launch-pad-agent`, `journalctl -u launch-pad-agent`),");
    log.dim(`  then re-run the same command with \`--name ${entry.nodeId}\` to resume the wait.`);
    log.dim(`  \`launchpad node destroy ${entry.nodeId}\` cleans up the IAM user + registry entry.`);
  } else {
    log.success(`node ${color.cyan(entry.nodeId)} is live and reconciling desired state`);
  }
  if (reachability) {
    if (reachability.ok) {
      log.success(
        `edge ${color.cyan(opts.edge)} can reach ${color.cyan(advertiseIp)}:${REACHABILITY_SAMPLE_PORT}`,
      );
    } else {
      log.warn(
        `edge ${opts.edge} could not verify ${advertiseIp}:${REACHABILITY_SAMPLE_PORT} — ${reachability.detail}`,
      );
      log.dim("  open the edge → BYOS host path for TCP 20000-29999 before deploying web services.");
    }
  }
}

/** Read a node.json, or null if it doesn't exist. */
async function loadNodeOrNull(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry | null> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
  if (!obj) return null;
  return parseNodeRegistryEntry(obj.raw);
}

/** Poll status.json until the node posts a fresh (non-stale) heartbeat, or the deadline passes. */
async function waitForFirstHeartbeat(aws: AwsEnv, nodeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
    if (obj) {
      try {
        const status = parseNodeStatus(obj.raw);
        if (!isHeartbeatStale(status.lastSeen, Date.now(), HEARTBEAT_STALE_MS)) return true;
      } catch {
        /* malformed status — keep polling */
      }
    }
    if (Date.now() >= deadline) return false;
    await sleep(3000);
  }
}

/** CAS-update the node's registry state to "ready" (best-effort — falls back to leaving it). */
async function markReady(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry["state"]> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
  if (!obj) return "provisioning";
  const current = parseNodeRegistryEntry(obj.raw);
  if (current.state === "ready") return "ready";
  try {
    await putJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId), { ...current, state: "ready" }, {
      ifMatch: obj.etag,
    });
    return "ready";
  } catch (error) {
    if (error instanceof PreconditionFailedError) return current.state; // raced — leave it
    throw error;
  }
}
