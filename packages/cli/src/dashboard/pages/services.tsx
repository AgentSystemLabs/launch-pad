/** Services — read-only port of the old dashboard's services page: `node list`
 * fanned out to per-node `status --node <id>` reads, flattened to one row per
 * (node, service). A node whose status read fails simply contributes no rows. */
import type { Handler } from "hono";
import { runLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import { StateBadge, ReplicaDots, ReplicaLegend, StateLegend } from "../components/service-state";
import { isBrokenNode, type NodeListJson, type StatusJson, type ServiceStatus } from "../lp-types";
import { lpOpts, pageResponse, safeParam, type DashboardCtx } from "../render";

interface ServiceRow {
  node: string;
  svc: ServiceStatus;
}

function shortImage(image: string): string {
  const slash = image.lastIndexOf("/");
  return slash >= 0 ? image.slice(slash + 1) : image;
}

export function servicesPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    if (!cluster) return c.text("not found", 404);
    const meta = { title: "Services", cluster, active: "services" as const };
    const crumbs = (
      <Breadcrumbs items={[{ label: "Clusters", href: "/clusters" }, { label: cluster }, { label: "Services" }]} />
    );

    let rows: ServiceRow[];
    try {
      const nodes = await runLaunchPad<NodeListJson>(["node", "list"], lpOpts(dctx, cluster));
      const statuses = await Promise.all(
        nodes
          .filter((n) => !isBrokenNode(n))
          .map((n) =>
            runLaunchPad<StatusJson>(["status", "--node", n.nodeId], lpOpts(dctx, cluster)).catch(
              () => [] as StatusJson,
            ),
          ),
      );
      rows = statuses
        .flat()
        .flatMap((entry) => (entry.status ? entry.status.services.map((svc) => ({ node: entry.node, svc })) : []));
    } catch (err) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <ErrorCard title="Couldn't load services" message={errorMessage(err)} />
        </div>,
      );
    }

    if (rows.length === 0) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <EmptyState title="No services running" message="Deploy a project to this cluster with `launchpad deploy`." />
        </div>,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        {crumbs}
        <h1 class="text-xl font-semibold">Services</h1>
        <div class="overflow-x-auto">
          <div class="flex flex-col gap-1 mb-2">
            <ReplicaLegend />
            <StateLegend />
          </div>
          <table class="table table-zebra" data-testid="services-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Node</th>
                <th>State</th>
                <th>Replicas</th>
                <th>Image</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, svc }) => (
                <tr data-testid={`svc-row-${svc.project}-${svc.service}`}>
                  <td class="font-mono">
                    {svc.project}/<span class="font-semibold">{svc.service}</span>
                  </td>
                  <td class="font-mono text-sm opacity-80">{node}</td>
                  <td>
                    <StateBadge state={svc.state} />
                  </td>
                  <td>
                    <div class="flex items-center gap-2">
                      <span class="text-sm tabular-nums">
                        {svc.runningReplicas}/{svc.desiredReplicas}
                      </span>
                      <ReplicaDots replicas={svc.replicas} />
                    </div>
                  </td>
                  <td class="font-mono text-xs opacity-70" title={svc.image}>
                    {shortImage(svc.image)}
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <a
                      class="link link-hover lp-focus-ring rounded-sm"
                      href={`/clusters/${cluster}/logs/${svc.project}/${svc.service}`}
                    >
                      Logs
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
