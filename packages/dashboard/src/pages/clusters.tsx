import type { Station } from "@orbital-js/station";
import { z } from "zod";
import type { AppCtx } from "../index";
import { runLaunchPad } from "../lib/run-launch-pad";
import { setDefaults } from "../lib/app-config";
import { confirmSubmit, flash } from "../lib/ui";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import type { ClusterListJson } from "../lib/lp-types";

const NAME_RULES = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and hyphens");

export function registerClusters(station: Station<AppCtx>) {
  // ── page shell ────────────────────────────────────────────────────────────
  station.template("clusters", () => (
    <div p-load="room:reset" class="space-y-6">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h1 class="text-2xl font-bold">Clusters</h1>
      </div>

      <form p-action="clusters:create" class="card bg-base-200">
        <div class="card-body p-4 flex-row flex-wrap items-end gap-3">
          <label class="form-control">
            <span class="label-text mb-1">Name</span>
            <input
              required
              name="name"
              placeholder="prod"
              pattern="[a-z0-9][a-z0-9-]*"
              class="input input-bordered input-sm w-44"
            />
          </label>
          <label class="form-control">
            <span class="label-text mb-1">Region (optional)</span>
            <input name="region" placeholder="us-east-1" class="input input-bordered input-sm w-44" />
          </label>
          <button class="btn btn-primary btn-sm">Create cluster</button>
        </div>
      </form>

      <div p-template="clusters:list"></div>
    </div>
  ));

  // ── list ──────────────────────────────────────────────────────────────────
  station.template("clusters:list", async ({ ctx }) => {
    let data: ClusterListJson;
    try {
      data = await runLaunchPad<ClusterListJson>(["cluster", "list"], {
        profile: ctx.profile,
        region: ctx.region,
      });
    } catch (err) {
      return (
        <ErrorCard
          title="Couldn't list clusters"
          message={errorMessage(err)}
        />
      );
    }

    const clusters = data.clusters ?? [];
    if (clusters.length === 0) {
      return (
        <EmptyState
          title="No clusters yet"
          message="Everything lives in the implicit 'default' cluster. Create one above to get started."
        />
      );
    }

    return (
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Cluster</th>
              <th>Region</th>
              <th>Source</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clusters.map((c) => {
              const active = c.clusterId === ctx.cluster;
              return (
                <tr data-testid={`cluster-row-${c.clusterId}`} class={active ? "bg-base-300" : ""}>
                  <td>
                    <span data-testid={`cluster-name-${c.clusterId}`} class="font-mono">
                      {c.clusterId}
                    </span>
                    {active ? <span class="badge badge-primary badge-sm ml-2">active</span> : <></>}
                    {data.defaultCluster === c.clusterId ? (
                      <span class="badge badge-ghost badge-sm ml-1">default</span>
                    ) : (
                      <></>
                    )}
                  </td>
                  <td class="opacity-80">{c.region ?? "—"}</td>
                  <td>
                    <span class="badge badge-ghost badge-sm">{c.source}</span>
                  </td>
                  <td>
                    <div class="flex gap-1 justify-end flex-wrap">
                      <a
                        href={`/clusters/${c.clusterId}/nodes`}
                        p-href={`/clusters/${c.clusterId}/nodes`}
                        p-target="content"
                        p-swap="nodes"
                        class="btn btn-ghost btn-xs lp-focus-ring"
                      >
                        Nodes
                      </a>
                      <a
                        href={`/clusters/${c.clusterId}/services`}
                        p-href={`/clusters/${c.clusterId}/services`}
                        p-target="content"
                        p-swap="services"
                        class="btn btn-ghost btn-xs lp-focus-ring"
                      >
                        Services
                      </a>
                      <form p-action="clusters:use">
                        <input type="hidden" name="name" value={c.clusterId} />
                        <button class="btn btn-ghost btn-xs" disabled={active}>
                          Use
                        </button>
                      </form>
                      <form
                        p-action="clusters:destroy"
                        onsubmit={confirmSubmit(`Destroy cluster ${c.clusterId}? This terminates all its nodes.`)}
                      >
                        <input type="hidden" name="name" value={c.clusterId} />
                        <button class="btn btn-error btn-outline btn-xs">Destroy</button>
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

  // ── actions ─────────────────────────────────────────────────────────────────
  station.defineAction("clusters:create", {
    input: z.object({ name: NAME_RULES, region: z.string().optional() }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      const args = ["cluster", "create", data.name];
      if (data.region && data.region.trim()) args.push("--region", data.region.trim());
      try {
        await runLaunchPad(args, { profile: ctx.profile, region: ctx.region });
        flash(ctx, invalidate, "success", `Created cluster "${data.name}"`);
        broadcast("clusters:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Create failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });

  station.defineAction("clusters:use", {
    input: z.object({ name: z.string().min(1) }),
    handler: ({ data, ctx, invalidate }) => {
      ctx.cluster = data.name;
      setDefaults({ defaultCluster: data.name });
      flash(ctx, invalidate, "success", `Active cluster set to "${data.name}"`);
      invalidate("clusters:list");
    },
  });

  station.defineAction("clusters:destroy", {
    input: z.object({ name: z.string().min(1) }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      try {
        await runLaunchPad(["cluster", "destroy", data.name, "--yes"], {
          cluster: data.name,
          profile: ctx.profile,
          region: ctx.region,
        });
        flash(ctx, invalidate, "success", `Destroyed cluster "${data.name}"`);
        broadcast("clusters:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Destroy failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });
}
