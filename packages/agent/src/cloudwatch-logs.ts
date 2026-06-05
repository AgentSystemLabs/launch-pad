import { writeFile } from "node:fs/promises";
import { execa } from "execa";
import {
  type CwAgentConfig,
  type CwLogFileEntry,
  cwAgentConfig,
  type NodeRole,
  buildSystemLogCollectList,
  cwLogFileEntry,
  logGroupName,
  logStreamName,
} from "@agentsystemlabs/launch-pad-shared";
import type { ManagedReplica } from "./docker";

/** Where docker's json-file driver writes each container's stdout/stderr. */
export const DOCKER_CONTAINERS_DIR = "/var/lib/docker/containers";

/** The combined (system + container) config the agent applies; replaces the boot-time base. */
export const CW_COMBINED_CONFIG_PATH = "/etc/launch-pad/cw-agent-combined.json";

/** CloudWatch Agent control binary on Amazon Linux 2023. */
export const CW_AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl";

/** Docker json-file log path for a container id. */
export function containerLogFilePath(containerId: string): string {
  return `${DOCKER_CONTAINERS_DIR}/${containerId}/${containerId}-json.log`;
}

export interface ContainerLogInput {
  clusterId: string;
  nodeId: string;
  /** Flattened live managed replicas (from inspectManaged()). */
  replicas: ManagedReplica[];
}

/**
 * Pure: map each managed container to a CloudWatch Agent collect_list entry that tails
 * its docker json log file into the service-first group/stream. Raw json lines are
 * shipped as-is (v1) — the CLI unwraps the `{"log":…}` wrapper when displaying.
 */
export function buildContainerLogCollectList(input: ContainerLogInput): CwLogFileEntry[] {
  return input.replicas
    .filter((r) => r.id && r.project && r.service)
    .map((r) =>
      cwLogFileEntry({
        filePath: containerLogFilePath(r.id),
        logGroupName: logGroupName(input.clusterId, r.project, r.service),
        logStreamName: logStreamName(input.nodeId, r.index),
      }),
    );
}

export interface CombinedConfigInput {
  clusterId: string;
  nodeId: string;
  role: NodeRole;
  replicas: ManagedReplica[];
}

/**
 * Pure: the full config the launch-pad agent applies — this node's system logs
 * (agent, plus caddy on edge/both) followed by one entry per running container.
 * `fetch-config` replaces the running config wholesale, so the system entries must be
 * present here too or the boot-time base would be dropped.
 */
export function buildCombinedCloudWatchConfig(input: CombinedConfigInput): CwAgentConfig {
  const system = buildSystemLogCollectList(input.clusterId, input.nodeId, input.role);
  const containers = buildContainerLogCollectList({
    clusterId: input.clusterId,
    nodeId: input.nodeId,
    replicas: input.replicas,
  });
  return cwAgentConfig([...system, ...containers]);
}

export interface CloudWatchSyncDeps {
  /** Persist the combined config (default: write to CW_COMBINED_CONFIG_PATH). */
  writeConfig?: (path: string, contents: string) => Promise<void>;
  /** Reload the CloudWatch Agent against the written config (default: run the ctl binary). */
  reload?: (configPath: string) => Promise<void>;
  /** Warning sink (default: stderr). */
  log?: (message: string) => void;
}

export interface CloudWatchAgentSync {
  /** Reconcile the CloudWatch Agent config to the given live replicas. Never throws. */
  sync(replicas: ManagedReplica[]): Promise<void>;
}

async function defaultWriteConfig(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
}

async function defaultReload(configPath: string): Promise<void> {
  await execa(CW_AGENT_CTL, [
    "-a",
    "fetch-config",
    "-m",
    "ec2",
    "-s",
    "-c",
    `file:${configPath}`,
  ]);
}

/**
 * A per-node CloudWatch Agent config reconciler. Each `sync()` renders the combined
 * config and, **only when it changed since last applied** (write-on-change, to avoid
 * reload churn), writes it and reloads the agent.
 *
 * It is degraded-safe by contract: any failure (CloudWatch Agent not installed, ctl
 * error, write error) is swallowed with a warning so the reconcile loop is never
 * broken by logging. On failure the fingerprint is left stale so the next tick retries.
 */
export function createCloudWatchAgentSync(
  base: { clusterId: string; nodeId: string; role: NodeRole },
  deps: CloudWatchSyncDeps = {},
): CloudWatchAgentSync {
  const writeConfig = deps.writeConfig ?? defaultWriteConfig;
  const reload = deps.reload ?? defaultReload;
  const warn = deps.log ?? ((m: string) => console.error(m));
  let lastApplied: string | null = null;

  return {
    async sync(replicas: ManagedReplica[]): Promise<void> {
      try {
        const config = buildCombinedCloudWatchConfig({ ...base, replicas });
        const serialized = `${JSON.stringify(config, null, 2)}\n`;
        if (serialized === lastApplied) return;
        await writeConfig(CW_COMBINED_CONFIG_PATH, serialized);
        await reload(CW_COMBINED_CONFIG_PATH);
        lastApplied = serialized;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`[agent] cloudwatch: log sync failed (continuing): ${message}`);
      }
    },
  };
}
