/**
 * TypeScript shapes for the `launch-pad … --json` output the dashboard consumes.
 *
 * These mirror the `printJson(...)` call sites in the CLI commands. Where the CLI
 * emits a shared domain object verbatim we reuse the shared type so the two cannot
 * drift; where it emits a command-specific envelope we declare it here.
 */
import type {
  NodeRegistryEntry,
  NodeStatus,
  ServiceStatus,
  ReplicaStatus,
  StatsLine,
  PreviewMarker,
  DeployEvent,
} from "@agentsystemlabs/launch-pad-shared";

export type {
  NodeRegistryEntry,
  NodeStatus,
  ServiceStatus,
  ReplicaStatus,
  StatsLine,
  PreviewMarker,
  DeployEvent,
};

/** `cluster list --json` */
export interface ClusterListJson {
  defaultCluster: string | null;
  clusters: Array<{
    clusterId: string;
    region: string | null;
    source: "implicit" | "local" | "s3" | "both";
    profile?: string;
    roleArn?: string;
  }>;
}

/** `node list --json` — each registry entry annotated with live EC2 reality. */
export type NodeListEntry = NodeRegistryEntry & {
  ec2State: string | null;
  drift: string;
  /** The (project, service) footprints scheduled on this node. */
  services: Array<{ project: string; service: string; replicas: number; cron: boolean }>;
};
/** An S3 node prefix whose node.json is absent or unparseable. */
export interface NodeListBrokenEntry {
  nodeId: string;
  status: "missing-registry" | "broken";
}
export type NodeListItem = NodeListEntry | NodeListBrokenEntry;
export type NodeListJson = NodeListItem[];

/** Narrow a `node list` item to the broken/missing shape. */
export function isBrokenNode(item: NodeListItem): item is NodeListBrokenEntry {
  return "status" in item;
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

/** A single log event from `logs … --follow --json` (NDJSON). */
export interface LogEventJson {
  timestamp: string;
  epochMillis: number;
  node: string | null;
  replica: number | null;
  stream: string;
  message: string;
}

/**
 * `destroy --list-envs --json` — each preview marker verbatim (shared `preview.ts`)
 * plus a computed `expired` flag (see `runListEnvs` in commands/destroy.ts).
 */
export type EnvListEntry = PreviewMarker & { expired: boolean };
export interface EnvListJson {
  envs: EnvListEntry[];
}

/**
 * `history --json` — the footprint owner plus its deploy events verbatim
 * (shared `events.ts` `DeployEvent`), newest first.
 */
export interface HistoryJson {
  project: string;
  events: DeployEvent[];
}
