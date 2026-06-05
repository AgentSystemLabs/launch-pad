import { type ServiceDecl, targetNodes } from "@agentsystemlabs/launch-pad-shared";

export interface Placement {
  nodeId: string;
  replicas: number;
}

/** Distribute `replicas` round-robin across `nodeIds`; drops nodes that get zero. */
export function distributeReplicas(nodeIds: string[], replicas: number): Placement[] {
  if (nodeIds.length === 0) return [];

  const counts = new Map<string, number>(nodeIds.map((n) => [n, 0]));
  for (let i = 0; i < replicas; i += 1) {
    const node = nodeIds[i % nodeIds.length] as string;
    counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return [...counts].filter(([, c]) => c > 0).map(([nodeId, replicas]) => ({ nodeId, replicas }));
}

/** Distribute a service's replicas across the nodes it pins explicitly (`node`/`nodes`). */
export function planPlacement(decl: ServiceDecl): Placement[] {
  return distributeReplicas(targetNodes(decl), decl.replicas);
}
