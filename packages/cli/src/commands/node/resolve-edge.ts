import { CliError } from "../../errors";

/**
 * Pick the edge an app node should route through, in priority order:
 *
 *   1. an explicit `--edge <nodeId>`
 *   2. the cluster's configured default edge (`cluster.json` `defaultEdge`)
 *   3. the cluster's single edge-role node (auto-attach — no flag needed)
 *
 * So creating an app node in a cluster that already has an edge "just works":
 * the user shouldn't have to name an edge that the cluster already defines.
 * Ambiguity (>1 edge with no default) and "no edge exists yet" are hard errors
 * with actionable hints. Mirrors how `deploy` / `rebalance` resolve the edge.
 */
export function planEdgeForAppNode(input: {
  clusterId: string;
  /** explicit `--edge` flag, if the user passed one */
  explicitEdge?: string | undefined;
  /** `cluster.json`'s `defaultEdge`, if set */
  defaultEdge?: string | null | undefined;
  /** every edge-role node id registered in the cluster */
  edgeRoleNodeIds: string[];
}): string {
  if (input.explicitEdge) return input.explicitEdge;
  if (input.defaultEdge) return input.defaultEdge;

  const edges = input.edgeRoleNodeIds;
  if (edges.length > 1) {
    throw new CliError(
      `cluster "${input.clusterId}" has ${edges.length} edge nodes (${edges.join(", ")}) and no default`,
      {
        hint: `pass --edge <edge-node-id>, or set a default: launchpad cluster set-edge ${input.clusterId} <edge-node-id>`,
      },
    );
  }
  const edge = edges[0];
  if (!edge) {
    throw new CliError("an app node needs an edge", {
      hint: "no edge node exists in this cluster yet — create one first: launchpad node create --role edge",
    });
  }
  return edge;
}
