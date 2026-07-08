/** Nodes — read-only port of the old dashboard's nodes page (list only, no actions). */
import type { Handler } from "hono";
import { runLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import { NodeStateBadge, NodeStateLegend } from "../components/node-state";
import { vcpu, mb } from "../format";
import { isBrokenNode, type NodeListJson, type NodeListBrokenEntry, type NodeListEntry } from "../lp-types";
import { lpOpts, pageResponse, safeParam, type DashboardCtx } from "../render";

function BrokenNodeRow({ entry }: { entry: NodeListBrokenEntry }) {
  return (
    <tr data-testid={`node-row-${entry.nodeId}`}>
      <td>
        <span data-testid={`node-name-${entry.nodeId}`} class="font-mono">
          {entry.nodeId}
        </span>
      </td>
      <td colspan={6}>
        <span class="badge badge-error badge-sm">
          {entry.status === "missing-registry" ? "missing node.json" : "node.json failed to parse"}
        </span>
      </td>
    </tr>
  );
}

function NodeRow({ node, cluster }: { node: NodeListEntry; cluster: string }) {
  const state = node.ec2State ?? node.state;
  return (
    <tr data-testid={`node-row-${node.nodeId}`}>
      <td>
        <span data-testid={`node-name-${node.nodeId}`} class="font-mono">
          {node.nodeId}
        </span>
        {node.drift && node.drift !== "none" ? (
          <span class="badge badge-warning badge-sm ml-2">drift: {node.drift}</span>
        ) : null}
      </td>
      <td class="opacity-80">{node.role}</td>
      <td class="font-mono text-sm">{node.instanceType}</td>
      <td>
        <NodeStateBadge state={state} />
      </td>
      <td class="text-sm opacity-80">
        {vcpu(node.totalCpu - node.reservedCpu)} · {mb(node.totalMemory - node.reservedMemory)}
      </td>
      <td class="text-sm opacity-80 font-mono">{node.role === "app" ? "VPC-private" : (node.publicIp ?? "—")}</td>
      <td class="text-right whitespace-nowrap">
        <a class="link link-hover lp-focus-ring rounded-sm" href={`/clusters/${cluster}/nodes/${node.nodeId}/monitor`}>
          Monitor
        </a>
      </td>
    </tr>
  );
}

export function nodesPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    if (!cluster) return c.text("not found", 404);
    const meta = { title: "Nodes", cluster, active: "nodes" as const };
    const crumbs = (
      <Breadcrumbs items={[{ label: "Clusters", href: "/clusters" }, { label: cluster }, { label: "Nodes" }]} />
    );

    let nodes: NodeListJson;
    try {
      nodes = await runLaunchPad<NodeListJson>(["node", "list"], lpOpts(dctx, cluster));
    } catch (err) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <ErrorCard title="Couldn't list nodes" message={errorMessage(err)} />
        </div>,
      );
    }

    if (!nodes || nodes.length === 0) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <EmptyState
            title="No nodes yet"
            message="Create one with `launchpad node create <name>` — a deploy also auto-provisions missing nodes."
          />
        </div>,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        {crumbs}
        <h1 class="text-xl font-semibold">Nodes</h1>
        <div class="overflow-x-auto">
          <div class="mb-2">
            <NodeStateLegend />
          </div>
          <table class="table table-zebra" data-testid="nodes-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Role</th>
                <th>Type</th>
                <th>State</th>
                <th>Capacity</th>
                <th>Address</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) =>
                isBrokenNode(n) ? <BrokenNodeRow entry={n} /> : <NodeRow node={n} cluster={cluster} />,
              )}
            </tbody>
          </table>
        </div>
      </div>,
    );
  };
}
