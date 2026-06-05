import {
  buildEdgeBackendsFromShards,
  edgeHealthPathForDomain,
  type DesiredState,
  serviceKey,
  type UpstreamShard,
} from "@agentsystemlabs/launch-pad-shared";
import type { WebRoute } from "./caddy";
import type { ManagedReplica } from "./docker";

/** Web ingress routed by co-located Caddy on this node (no remote edge hop). */
export function isCoLocatedIngress(nodeId: string, edge: string | null): boolean {
  return edge === null || edge === nodeId;
}

/** Caddy routes for services whose edge is co-located on this node. */
export function buildCoLocatedRoutes(
  nodeId: string,
  desired: DesiredState,
  live: Map<string, ManagedReplica[]>,
  excludeIds: Set<string> = new Set(),
): WebRoute[] {
  const routes: WebRoute[] = [];
  for (const c of desired.services) {
    if (!c.ingress || !isCoLocatedIngress(nodeId, c.ingress.edge)) continue;
    const reps = (live.get(serviceKey(c.project, c.service)) ?? []).filter(
      (r) => r.state === "running" && r.hostPort != null && !excludeIds.has(r.id),
    );
    if (reps.length === 0) continue;
    routes.push({
      domain: c.ingress.domain,
      upstreams: reps.map((r) => `127.0.0.1:${r.hostPort}`),
      healthPath: c.healthCheck?.path,
    });
  }
  return routes;
}

/** Caddy routes from app-published upstream shards (remote edge / both nodes). */
export function buildShardRoutes(shards: UpstreamShard[]): WebRoute[] {
  const backends = buildEdgeBackendsFromShards(shards);
  const routes: WebRoute[] = [];
  for (const [domain, list] of backends) {
    routes.push({
      domain,
      upstreams: list.map((b) => `${b.privateIp}:${b.hostPort}`),
      healthPath: edgeHealthPathForDomain(shards, domain),
    });
  }
  return routes;
}

/** Merge routes for the same domain by unioning upstreams (round-robin load balancing). */
export function mergeRoutesByDomain(routes: WebRoute[]): WebRoute[] {
  const byDomain = new Map<string, WebRoute>();
  for (const route of routes) {
    const existing = byDomain.get(route.domain);
    if (!existing) {
      byDomain.set(route.domain, {
        domain: route.domain,
        upstreams: [...route.upstreams],
        healthPath: route.healthPath,
      });
      continue;
    }
    existing.upstreams.push(...route.upstreams);
    existing.healthPath ??= route.healthPath;
  }
  return [...byDomain.values()];
}
