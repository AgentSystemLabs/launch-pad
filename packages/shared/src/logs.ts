/**
 * CloudWatch Logs naming + CloudWatch-Agent config shaping. These are the only
 * source of truth for log-group / log-stream names so the agent (which ships logs),
 * the node provisioning (which scopes IAM + the base config), and the CLI (which
 * reads logs back by service) cannot drift on the naming scheme.
 *
 * The scheme is **service-first**: one log group per service footprint (aggregating
 * every node + replica), with the node + replica encoded in the stream name. So
 * `launch-pad logs <service>` reads one group and sees all replicas across all nodes.
 */

import type { NodeRole } from "./registry";

/** Default CloudWatch Logs retention applied on first write. Not yet TOML-configurable. */
export const LOG_RETENTION_DAYS = 7;

/** On-box directory the journald→file forwarders write to (tailed by the CW agent). */
export const SYSTEM_LOG_DIR = "/var/log/launch-pad";

/**
 * Log group for a service footprint: `/launch-pad/{clusterId}/{project}/{service}`.
 * `project` must be the **effective** project (`envProject(project, env)`), the same
 * value used for container names, so an environment's logs land in their own group.
 */
export function logGroupName(clusterId: string, project: string, service: string): string {
  return `/launch-pad/${clusterId}/${project}/${service}`;
}

/** Log stream within a service group: `{nodeId}/{replicaIndex}` (which node, which replica). */
export function logStreamName(nodeId: string, replicaIndex: number): string {
  return `${nodeId}/${replicaIndex}`;
}

/** System (agent + caddy) log group for a node: `/launch-pad/{clusterId}/system/{nodeId}`. */
export function systemLogGroupName(clusterId: string, nodeId: string): string {
  return `/launch-pad/${clusterId}/system/${nodeId}`;
}

/** The on-box components whose journald output is shipped to the system group. */
export type SystemComponent = "agent" | "caddy";

/** System log stream is just the component name: `agent` | `caddy`. */
export function systemLogStreamName(component: SystemComponent): string {
  return component;
}

export interface ParsedLogStream {
  nodeId: string;
  replicaIndex: number;
}

/**
 * Inverse of {@link logStreamName} — recover `{ nodeId, replicaIndex }` from a stream
 * name so the CLI can render `[{nodeId}/{replica}]`. Returns null for an unparseable
 * stream (e.g. a system stream like `agent`), letting the caller fall back to the raw name.
 */
export function parseLogStreamName(stream: string): ParsedLogStream | null {
  const slash = stream.lastIndexOf("/");
  if (slash <= 0) return null;
  const nodeId = stream.slice(0, slash);
  const replicaIndex = Number.parseInt(stream.slice(slash + 1), 10);
  if (!nodeId || Number.isNaN(replicaIndex)) return null;
  return { nodeId, replicaIndex };
}

// ── CloudWatch Agent config shaping ─────────────────────────────────────────────
//
// The Amazon CloudWatch Agent tails files. App containers are tailed directly from
// their docker json log file; node-system logs (agent/caddy journald) are forwarded
// to a plain file (see SYSTEM_LOG_DIR) and tailed from there. Both produce the same
// `collect_list` entry shape below.

/** One `logs.logs_collected.files.collect_list` entry for the CloudWatch Agent. */
export interface CwLogFileEntry {
  file_path: string;
  log_group_name: string;
  log_stream_name: string;
  timezone: "UTC";
  retention_in_days: number;
}

/** The subset of the CloudWatch Agent config document launch-pad writes. */
export interface CwAgentConfig {
  logs: {
    logs_collected: {
      files: {
        collect_list: CwLogFileEntry[];
      };
    };
  };
}

export function cwLogFileEntry(params: {
  filePath: string;
  logGroupName: string;
  logStreamName: string;
  retentionDays?: number;
}): CwLogFileEntry {
  return {
    file_path: params.filePath,
    log_group_name: params.logGroupName,
    log_stream_name: params.logStreamName,
    timezone: "UTC",
    retention_in_days: params.retentionDays ?? LOG_RETENTION_DAYS,
  };
}

/** Wrap a collect_list into a full (partial) CloudWatch Agent config document. */
export function cwAgentConfig(collectList: CwLogFileEntry[]): CwAgentConfig {
  return { logs: { logs_collected: { files: { collect_list: collectList } } } };
}

/** Forwarded-journald file a system component logs to on the node. */
export function systemLogFilePath(component: SystemComponent): string {
  return `${SYSTEM_LOG_DIR}/${component}.log`;
}

/**
 * Which system components a role ships: the agent runs everywhere; Caddy only runs on
 * `edge`/`both` nodes, so an `app` node ships agent logs only.
 */
export function systemComponentsForRole(role: NodeRole): SystemComponent[] {
  return role === "app" ? ["agent"] : ["agent", "caddy"];
}

/** collect_list entries for a node's own system logs (agent, plus caddy on edge/both). */
export function buildSystemLogCollectList(
  clusterId: string,
  nodeId: string,
  role: NodeRole,
): CwLogFileEntry[] {
  return systemComponentsForRole(role).map((component) =>
    cwLogFileEntry({
      filePath: systemLogFilePath(component),
      logGroupName: systemLogGroupName(clusterId, nodeId),
      logStreamName: systemLogStreamName(component),
    }),
  );
}

/** The base CloudWatch Agent config a node ships before the launch-pad agent's first tick. */
export function systemCwConfig(clusterId: string, nodeId: string, role: NodeRole): CwAgentConfig {
  return cwAgentConfig(buildSystemLogCollectList(clusterId, nodeId, role));
}
