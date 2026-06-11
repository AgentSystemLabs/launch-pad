import type { Station } from "@orbital-js/station";
import { z } from "zod";
import type { AppCtx } from "../index";
import { runLaunchPad } from "../lib/run-launch-pad";
import { getProject } from "../lib/app-config";
import { flash } from "../lib/ui";
import { ErrorCard, EmptyState, errorMessage, DisabledTip } from "../components/feedback";
import { Breadcrumbs } from "../components/breadcrumbs";
import { StateBadge, ReplicaDots, ReplicaLegend, StateLegend } from "../components/service-state";
import type { NodeListJson, StatusJson, ServiceStatus } from "../lib/lp-types";

interface ServiceRow {
  node: string;
  svc: ServiceStatus;
}

function shortImage(image: string): string {
  const slash = image.lastIndexOf("/");
  return slash >= 0 ? image.slice(slash + 1) : image;
}

export function registerServices(station: Station<AppCtx>) {
  station.template("services", ({ params }) => {
    const cluster = params.cluster ?? "default";
    return (
      <div p-load="room:reset" class="space-y-6">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/", swap: "clusters" },
            { label: cluster },
            { label: "Services" },
          ]}
        />
        <div class="flex items-center justify-between flex-wrap gap-2">
          <h1 class="text-2xl font-bold">Services</h1>
          <a href="/projects" p-href="/projects" p-target="content" p-swap="projects" class="btn btn-primary btn-sm">
            Deploy a project →
          </a>
        </div>
        <div p-template="services:list"></div>
      </div>
    );
  });

  station.template("services:list", async ({ ctx, params }) => {
    const cluster = params.cluster ?? "default";
    let rows: ServiceRow[];
    try {
      const nodes = await runLaunchPad<NodeListJson>(["node", "list"], {
        cluster,
        profile: ctx.profile,
        region: ctx.region,
      });
      const statuses = await Promise.all(
        nodes.map((n) =>
          runLaunchPad<StatusJson>(["status", "--node", n.nodeId], {
            cluster,
            profile: ctx.profile,
            region: ctx.region,
          }).catch(() => [] as StatusJson),
        ),
      );
      rows = statuses
        .flat()
        .flatMap((entry) =>
          entry.status ? entry.status.services.map((svc) => ({ node: entry.node, svc })) : [],
        );
    } catch (err) {
      return <ErrorCard title="Couldn't load services" message={errorMessage(err)} />;
    }

    if (rows.length === 0) {
      return (
        <EmptyState
          title="No services running"
          message="Deploy a project to this cluster's nodes from the Projects page."
        />
      );
    }

    return (
      <div class="overflow-x-auto">
        <div class="flex flex-col gap-1 mb-2">
          <ReplicaLegend />
          <StateLegend />
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Node</th>
              <th>State</th>
              <th>Replicas</th>
              <th>Image</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, svc }) => {
              const registered = getProject(svc.project);
              return (
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
                  <td>
                    <div class="flex gap-1 justify-end items-center">
                      <a
                        href={`/clusters/${cluster}/logs/${svc.project}/${svc.service}`}
                        p-href={`/clusters/${cluster}/logs/${svc.project}/${svc.service}`}
                        p-target="content"
                        p-swap="logs"
                        class="btn btn-ghost btn-xs lp-focus-ring"
                      >
                        Logs
                      </a>
                      <form p-action="services:redeploy">
                        <input type="hidden" name="cluster" value={cluster} />
                        <input type="hidden" name="project" value={svc.project} />
                        {registered ? (
                          <button class="btn btn-ghost btn-xs">Redeploy</button>
                        ) : (
                          <DisabledTip
                            reason="Register this project on the Projects page first"
                            testId={`redeploy-tip-${svc.project}-${svc.service}`}
                          >
                            <button type="button" class="btn btn-ghost btn-xs" disabled tabIndex={-1}>
                              Redeploy
                            </button>
                          </DisabledTip>
                        )}
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  });

  station.defineAction("services:redeploy", {
    input: z.object({ cluster: z.string().min(1), project: z.string().min(1) }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      const project = getProject(data.project);
      if (!project) {
        flash(ctx, invalidate, "error", `Project "${data.project}" isn't registered — add it on Projects`);
        reply({ ok: false });
        return;
      }
      try {
        await runLaunchPad(["deploy", "--yes"], {
          cwd: project.dir,
          cluster: data.cluster,
          profile: ctx.profile,
          region: ctx.region,
        });
        flash(ctx, invalidate, "success", `Redeployed "${data.project}"`);
        broadcast("services:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Redeploy failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });
}
