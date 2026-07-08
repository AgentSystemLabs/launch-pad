/** Clusters — read-only port of the old dashboard's clusters page. */
import type { Handler } from "hono";
import { runLaunchPad } from "../cli-driver";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import type { ClusterListJson } from "../lp-types";
import { navCluster, lpOpts, pageResponse, type DashboardCtx } from "../render";

export function clustersPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = navCluster(dctx);
    const meta = { title: "Clusters", cluster, active: "clusters" as const };

    let data: ClusterListJson;
    try {
      data = await runLaunchPad<ClusterListJson>(["cluster", "list"], {
        profile: lpOpts(dctx).profile,
        region: lpOpts(dctx).region,
      });
    } catch (err) {
      return pageResponse(c, meta, <ErrorCard title="Failed to list clusters" message={errorMessage(err)} />);
    }

    if (!data || !data.clusters.length) {
      return pageResponse(
        c,
        meta,
        <EmptyState
          title="No clusters yet"
          message="Deploy a project (`launchpad deploy`) or create a cluster (`launchpad cluster create`) to get started."
        />,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        <h1 class="text-xl font-semibold">Clusters</h1>
        <div class="overflow-x-auto">
          <table class="table table-zebra" data-testid="clusters-table">
            <thead>
              <tr>
                <th>Cluster</th>
                <th>Region</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.clusters.map((row) => (
                <tr data-testid={`cluster-row-${row.clusterId}`}>
                  <td class="font-mono">
                    {row.clusterId}
                    {data.defaultCluster === row.clusterId ? (
                      <span class="badge badge-primary badge-outline badge-sm ml-2">default</span>
                    ) : null}
                  </td>
                  <td>{row.region ?? "—"}</td>
                  <td>
                    <span class="badge badge-ghost badge-sm">{row.source}</span>
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <a class="link link-hover mr-3 lp-focus-ring rounded-sm" href={`/clusters/${row.clusterId}/nodes`}>
                      Nodes
                    </a>
                    <a class="link link-hover mr-3 lp-focus-ring rounded-sm" href={`/clusters/${row.clusterId}/services`}>
                      Services
                    </a>
                    <a class="link link-hover lp-focus-ring rounded-sm" href={`/clusters/${row.clusterId}/environments`}>
                      Environments
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>,
    );
  };
}
