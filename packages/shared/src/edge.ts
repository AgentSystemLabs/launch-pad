import { z } from "zod";
import { type DesiredState, serviceKey } from "./desired";
import type { NodeRegistryEntry } from "./registry";
import type { NodeStatus } from "./status";

/** Advisory `edge.json`: the domains an edge node fronts (for cold-start + display). */
export const EdgeConfigSchema = z
  .object({
    nodeId: z.string().min(1),
    domains: z.array(z.string().min(1)).default([]),
    updatedAt: z.string(),
  })
  .strict();
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;

export interface EdgeBackend {
  domain: string;
  privateIp: string;
  hostPort: number;
}

/** One upstream target an app agent publishes for its edge. */
export const UpstreamBackendSchema = z
  .object({
    domain: z.string().min(1),
    hostPort: z.number().int().positive(),
    healthPath: z.string().optional(),
  })
  .strict();
export type UpstreamBackend = z.infer<typeof UpstreamBackendSchema>;

/** Routing telemetry an app agent writes into an edge node's upstream prefix. */
export const UpstreamShardSchema = z
  .object({
    nodeId: z.string().min(1),
    privateIp: z.string().min(1),
    updatedAt: z.string(),
    backends: z.array(UpstreamBackendSchema).default([]),
  })
  .strict();
export type UpstreamShard = z.infer<typeof UpstreamShardSchema>;

export function parseUpstreamShard(input: unknown): UpstreamShard {
  return UpstreamShardSchema.parse(input);
}

/** One cluster member joined with its live S3 state, as seen by the edge. */
export interface ClusterNode {
  entry: NodeRegistryEntry;
  status: NodeStatus | null;
  desired: DesiredState | null;
}

/**
 * Build the per-domain upstream list by CROSS-READING other nodes' desired.json +
 * status.json: for every app node in the cluster, join its desired services
 * (domain + edge ownership) with its status (running, healthy replicas + host
 * ports), keeping only services routed by `edgeNodeId`.
 *
 * ⚠️ This is NOT the production routing path and intentionally VIOLATES the
 * "push-based routing, never cross-reads" invariant (see CLAUDE.md). The live
 * edge agent uses `buildEdgeBackendsFromShards` (below), which reads only its own
 * `upstream/*` prefix. This function is retained for tests / debugging that need
 * to compute the expected routing table from raw node state — do not call it from
 * the agent.
 */
export function buildEdgeBackendsByCrossRead(
  edgeNodeId: string,
  nodes: ClusterNode[],
): Map<string, EdgeBackend[]> {
  const result = new Map<string, EdgeBackend[]>();

  for (const node of nodes) {
    if (node.entry.nodeId === edgeNodeId) continue;
    const privateIp = node.entry.privateIp;
    if (!privateIp || !node.desired || !node.status) continue;

    const statusByKey = new Map(
      node.status.services.map((s) => [serviceKey(s.project, s.service), s]),
    );

    for (const ds of node.desired.services) {
      if (!ds.ingress || ds.ingress.edge !== edgeNodeId) continue;
      const st = statusByKey.get(serviceKey(ds.project, ds.service));
      if (!st) continue;

      for (const replica of st.replicas) {
        if (replica.state === "running" && replica.healthy && replica.hostPort != null) {
          const list = result.get(ds.ingress.domain) ?? [];
          list.push({ domain: ds.ingress.domain, privateIp, hostPort: replica.hostPort });
          result.set(ds.ingress.domain, list);
        }
      }
    }
  }

  return result;
}

/** Build Caddy upstreams from app-published routing shards (edge agent read path). */
export function buildEdgeBackendsFromShards(shards: UpstreamShard[]): Map<string, EdgeBackend[]> {
  const result = new Map<string, EdgeBackend[]>();

  for (const shard of shards) {
    for (const b of shard.backends) {
      const list = result.get(b.domain) ?? [];
      list.push({ domain: b.domain, privateIp: shard.privateIp, hostPort: b.hostPort });
      result.set(b.domain, list);
    }
  }

  return result;
}

/** First health path published for a domain across shards (for Caddy active checks). */
export function edgeHealthPathForDomain(
  shards: UpstreamShard[],
  domain: string,
): string | undefined {
  for (const shard of shards) {
    for (const b of shard.backends) {
      if (b.domain === domain && b.healthPath) return b.healthPath;
    }
  }
  return undefined;
}
