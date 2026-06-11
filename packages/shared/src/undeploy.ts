import type { ConfigBaseline } from "./config-lock";
import type { ServiceConfig } from "./desired";

/** One node's removal slice for an undeploy: what to drop, and what survives there. */
export interface NodeUndeployPlan {
  nodeId: string;
  /** Names of the footprint's services removed from this node. */
  removed: string[];
  /**
   * The footprint's services that REMAIN on this node after the removal — the exact
   * `ServiceConfig`s to re-publish via an ownership-aware merge (empty for a full
   * undeploy, or when only this footprint's other services live elsewhere).
   */
  kept: ServiceConfig[];
}

export interface UndeployPlan {
  /** Only the nodes that actually host at least one removed service. */
  nodes: NodeUndeployPlan[];
  /** Distinct footprint services removed across all nodes, sorted. */
  removedServices: string[];
  /**
   * Web domains that no surviving replica fronts after the removal, sorted — safe to
   * prune from edge.json (a domain a kept replica still serves is NOT listed).
   */
  removedDomains: string[];
  /** Edges that fronted a now-removed domain, sorted (for advisory edge.json pruning). */
  affectedEdges: string[];
}

/**
 * Plan an undeploy purely from each node's published desired state. `servicesToRemove`
 * = `null` removes the whole footprint; a list removes only those named services. Only
 * the footprint's (`ownerProject`'s) services are ever touched — another project's
 * services on the same node are invisible to this plan. No S3, no mutation.
 */
export function planUndeploy(
  states: Array<{ nodeId: string; services: ServiceConfig[] }>,
  ownerProject: string,
  servicesToRemove: string[] | null,
): UndeployPlan {
  const removeSet = servicesToRemove === null ? null : new Set(servicesToRemove);
  const shouldRemove = (service: string): boolean => removeSet === null || removeSet.has(service);

  const nodes: NodeUndeployPlan[] = [];
  const removedServices = new Set<string>();
  // Domains fronted by removed vs surviving services — a domain is only "removed"
  // when nothing left (this footprint OR any other) still serves it.
  const removedDomainCandidates = new Map<string, Set<string>>(); // domain -> edges that fronted it
  const survivingDomains = new Set<string>();

  for (const { nodeId, services } of states) {
    const owned = services.filter((s) => s.project === ownerProject);
    const removed = owned.filter((s) => shouldRemove(s.service));
    const kept = owned.filter((s) => !shouldRemove(s.service));

    // A service surviving anywhere (this footprint OR another project) keeps its domain alive.
    for (const s of services) {
      const removedHere = s.project === ownerProject && shouldRemove(s.service);
      if (!removedHere && s.ingress?.domain) survivingDomains.add(s.ingress.domain);
    }

    if (removed.length === 0) continue;

    for (const s of removed) {
      removedServices.add(s.service);
      if (s.ingress?.domain) {
        const edges = removedDomainCandidates.get(s.ingress.domain) ?? new Set<string>();
        if (s.ingress.edge) edges.add(s.ingress.edge);
        removedDomainCandidates.set(s.ingress.domain, edges);
      }
    }
    nodes.push({ nodeId, removed: removed.map((s) => s.service).sort(), kept });
  }

  const removedDomains: string[] = [];
  const affectedEdges = new Set<string>();
  for (const [domain, edges] of removedDomainCandidates) {
    if (survivingDomains.has(domain)) continue; // a kept replica still fronts it
    removedDomains.push(domain);
    for (const e of edges) affectedEdges.add(e);
  }

  return {
    nodes: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    removedServices: [...removedServices].sort(),
    removedDomains: removedDomains.sort(),
    affectedEdges: [...affectedEdges].sort(),
  };
}

/**
 * The desired-state services that remain after a removal — the exact list to re-publish
 * to a node's desired.json. `removeSet = null` drops the whole footprint; a set drops only
 * those services. Re-derived from LIVE desired state on each CAS attempt (not the planning
 * snapshot) so a concurrent deploy's changes to the footprint aren't clobbered. Another
 * project's services pass through untouched.
 */
export function servicesAfterRemoval(
  existing: ServiceConfig[],
  ownerProject: string,
  removeSet: Set<string> | null,
): ServiceConfig[] {
  return existing.filter(
    (s) => !(s.project === ownerProject && (removeSet === null || removeSet.has(s.service))),
  );
}

/**
 * Drop the named services from a config baseline so a follow-up `deploy` of the edited
 * launch-pad.toml (with those `[[service]]` blocks gone) passes the config lock instead
 * of tripping its "service removed" guard. Returns `null` when no service remains — the
 * caller deletes the baseline file so the footprint's next deploy is a fresh first deploy.
 */
export function removeServicesFromBaseline(
  baseline: ConfigBaseline,
  removedServiceNames: string[],
): ConfigBaseline | null {
  const drop = new Set(removedServiceNames);
  const services = baseline.services.filter((s) => !drop.has(s.name));
  if (services.length === 0) return null;
  return { ...baseline, services };
}
