/**
 * Pure placement-diff for `rebalance` / `node evacuate`: compare a footprint's CURRENT
 * per-node placement against a freshly PLANNED one and report what moves. The command
 * layer uses this to publish only the affected nodes and to clean the ones a service
 * leaves entirely. Mutates nothing it's given.
 */

/** A service's replica distribution: nodeId → replica count (zero-count nodes ignored). */
export interface ServicePlacement {
  service: string;
  byNode: Map<string, number>;
}

/** One (service, node) cell whose replica count changed. */
export interface RebalanceChange {
  service: string;
  node: string;
  from: number;
  to: number;
}

export interface RebalanceDiff {
  /** True when any (service, node) cell differs. */
  changed: boolean;
  /** Changed cells, sorted by (service, node) — `to === 0` means the service left that node. */
  changes: RebalanceChange[];
  /** Nodes that hosted ANY of the footprint before but host NONE of it after, sorted. */
  vacatedNodes: string[];
}

/** Sum a footprint's replicas per node across all its services (drops zero-count cells). */
function occupancyByNode(placement: ServicePlacement[]): Map<string, number> {
  const total = new Map<string, number>();
  for (const { byNode } of placement) {
    for (const [node, replicas] of byNode) {
      if (replicas <= 0) continue;
      total.set(node, (total.get(node) ?? 0) + replicas);
    }
  }
  return total;
}

function bySvc(placement: ServicePlacement[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const { service, byNode } of placement) {
    const clean = new Map<string, number>();
    for (const [node, replicas] of byNode) if (replicas > 0) clean.set(node, replicas);
    map.set(service, clean);
  }
  return map;
}

export function diffPlacement(
  current: ServicePlacement[],
  planned: ServicePlacement[],
): RebalanceDiff {
  const cur = bySvc(current);
  const next = bySvc(planned);

  const services = new Set<string>([...cur.keys(), ...next.keys()]);
  const changes: RebalanceChange[] = [];
  for (const service of services) {
    const a = cur.get(service) ?? new Map<string, number>();
    const b = next.get(service) ?? new Map<string, number>();
    for (const node of new Set<string>([...a.keys(), ...b.keys()])) {
      const from = a.get(node) ?? 0;
      const to = b.get(node) ?? 0;
      if (from !== to) changes.push({ service, node, from, to });
    }
  }
  changes.sort((x, y) => x.service.localeCompare(y.service) || x.node.localeCompare(y.node));

  const before = occupancyByNode(current);
  const after = occupancyByNode(planned);
  const vacatedNodes = [...before.keys()].filter((node) => !after.has(node)).sort();

  return { changed: changes.length > 0, changes, vacatedNodes };
}
