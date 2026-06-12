/**
 * TypeScript shapes for the `launch-pad … --json` output the dashboard consumes.
 *
 * These mirror the `printJson(...)` call sites in the CLI (packages/cli/src/commands/*).
 * Where the CLI emits a shared domain object verbatim we reuse the shared type so the
 * two cannot drift; where it emits a command-specific envelope we declare it here.
 */
import type {
  NodeRegistryEntry,
  NodeStatus,
  ServiceStatus,
  ReplicaStatus,
  ClusterConfig,
  DesiredState,
  ServiceConfig,
  StatsLine,
} from "@agentsystemlabs/launch-pad-shared";

export type {
  NodeRegistryEntry,
  NodeStatus,
  ServiceStatus,
  ReplicaStatus,
  ClusterConfig,
  DesiredState,
  ServiceConfig,
  StatsLine,
};

/** `cluster list --json` */
export interface ClusterListJson {
  defaultCluster: string | null;
  clusters: Array<{
    clusterId: string;
    region: string | null;
    source: "local" | "s3" | "both";
    profile?: string;
    roleArn?: string;
  }>;
}

/** One scheduled service from a node's desired.json (`cluster show`). */
export interface ClusterServiceSummary {
  project: string;
  service: string;
  replicas: number;
  image: string;
  domain: string | null;
  cron?: string;
}

/** `cluster show <name> --json` */
export interface ClusterShowJson {
  cluster: ClusterConfig | null;
  account: string;
  region: string;
  nodes: NodeRegistryEntry[];
  workloads: Array<{ nodeId: string; services: ClusterServiceSummary[] }>;
  scheduledServices: number;
}

/** `node list --json` — each registry entry annotated with live EC2 reality. */
export type NodeListEntry = NodeRegistryEntry & {
  ec2State: string | null;
  drift: string;
};
export type NodeListJson = NodeListEntry[];

/**
 * `node show <name> --json`. Note: `desired` / `status` are the raw S3 JSON
 * *strings* (the CLI prints `obj.raw`), so parse them with the shared parsers
 * before use, rather than treating them as already-decoded objects.
 */
export interface NodeShowJson {
  node: NodeRegistryEntry & { publicIp: string | null };
  ec2: { state: string; drift: string } | null;
  desired: string | null;
  status: string | null;
}

/** `status [--node <id>] --json` */
export type StatusJson = Array<{ node: string; status: NodeStatus | null }>;

/** A single sample from `node monitor --watch --json` (one per NDJSON line) */
export type StatsSample = StatsLine & { epochMillis: number };

/** `node monitor <node> --since <w> --json` (historic) */
export interface MonitorHistoricJson {
  node: string;
  cluster: string;
  window: string;
  samples: StatsSample[];
}

/** A single log event from `logs … --json` / `logs --follow --json` (NDJSON). */
export interface LogEventJson {
  timestamp: string;
  epochMillis: number;
  node: string | null;
  replica: number | null;
  stream: string;
  message: string;
}

/** `logs <service> --json` (non-follow) */
export interface LogsJson {
  logGroup: string;
  events: LogEventJson[];
}

/** `deploy --json` final block (also emitted with exit code 1 when not converged). */
export interface DeployConvergedJson {
  converged: boolean;
  services: Array<{
    nodeId?: string;
    project?: string;
    service?: string;
    image?: string;
    state?: string;
    ok: boolean;
    message?: string;
  }>;
}
