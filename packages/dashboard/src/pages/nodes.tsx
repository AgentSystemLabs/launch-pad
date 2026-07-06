import type { Station } from "@orbital-js/station";
import { z } from "zod";
import type { AppCtx } from "../index";
import { runLaunchPad } from "../lib/run-launch-pad";
import { flash } from "../lib/ui";
import { vcpu, mb } from "../lib/format";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import { Breadcrumbs } from "../components/breadcrumbs";
import { NodeStateBadge, NodeStateLegend } from "../components/node-state";
import type { NodeListJson, NodeListEntry } from "../lib/lp-types";

const NAME_RULES = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and hyphens");

const INSTANCE_TYPES = ["t3.micro", "t3.small", "t3.medium", "t3.large", "c5.large", "c5.xlarge"];

function isRunning(n: NodeListEntry): boolean {
  return (n.ec2State ?? n.state) === "running" || n.state === "ready";
}

function ClusterField({ cluster }: { cluster: string }) {
  return <input type="hidden" name="cluster" value={cluster} />;
}

export function registerNodes(station: Station<AppCtx>) {
  // ── page shell ────────────────────────────────────────────────────────────
  station.template("nodes", ({ params }) => {
    const cluster = params.cluster ?? "default";
    return (
      <div p-load="room:reset" class="space-y-6">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/", swap: "clusters" },
            { label: cluster },
            { label: "Nodes" },
          ]}
        />
        <h1 class="text-2xl font-bold">Nodes</h1>

        <form p-action="nodes:create" class="card bg-base-200">
          <div class="card-body p-4 flex-row flex-wrap items-end gap-3">
            <ClusterField cluster={cluster} />
            <label class="form-control">
              <span class="label-text mb-1">Name</span>
              <input
                required
                name="name"
                placeholder="web-2"
                pattern="[a-z0-9][a-z0-9-]*"
                class="input input-bordered input-sm w-40"
              />
            </label>
            <label class="form-control">
              <span class="label-text mb-1">Instance type</span>
              <select name="instanceType" class="select select-bordered select-sm w-36">
                {INSTANCE_TYPES.map((t) => (
                  <option value={t} selected={t === "t3.small"}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label class="form-control">
              <span class="label-text mb-1">Role</span>
              <select name="role" class="select select-bordered select-sm w-28">
                <option value="app" selected>
                  app
                </option>
                <option value="edge">edge</option>
              </select>
            </label>
            <label class="form-control">
              <span class="label-text mb-1">Edge (app only)</span>
              <input name="edge" placeholder="edge-1" class="input input-bordered input-sm w-32" />
            </label>
            <button class="btn btn-primary btn-sm">Create node</button>
          </div>
        </form>

        <div p-template="nodes:list"></div>
      </div>
    );
  });

  // ── list ──────────────────────────────────────────────────────────────────
  station.template("nodes:list", async ({ ctx, params }) => {
    const cluster = params.cluster ?? "default";
    let nodes: NodeListJson;
    try {
      nodes = await runLaunchPad<NodeListJson>(["node", "list"], {
        cluster,
        profile: ctx.profile,
        region: ctx.region,
      });
    } catch (err) {
      return <ErrorCard title="Couldn't list nodes" message={errorMessage(err)} />;
    }

    if (!nodes || nodes.length === 0) {
      return (
        <EmptyState
          title="No nodes yet"
          message="Create a node above. A deploy will also auto-provision missing nodes."
        />
      );
    }

    return (
      <div class="overflow-x-auto">
        <div class="mb-2">
          <NodeStateLegend />
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Node</th>
              <th>Role</th>
              <th>Type</th>
              <th>State</th>
              <th>Capacity</th>
              <th>Address</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const running = isRunning(n);
              const state = n.ec2State ?? n.state;
              return (
                <tr data-testid={`node-row-${n.nodeId}`}>
                  <td>
                    <span data-testid={`node-name-${n.nodeId}`} class="font-mono">
                      {n.nodeId}
                    </span>
                    {n.drift && n.drift !== "none" ? (
                      <span class="badge badge-warning badge-sm ml-2">drift: {n.drift}</span>
                    ) : (
                      <></>
                    )}
                  </td>
                  <td class="opacity-80">{n.role}</td>
                  <td class="font-mono text-sm">{n.instanceType}</td>
                  <td>
                    <NodeStateBadge state={state} />
                  </td>
                  <td class="text-sm opacity-80">
                    {vcpu(n.totalCpu - n.reservedCpu)} · {mb(n.totalMemory - n.reservedMemory)}
                  </td>
                  <td class="text-sm opacity-80 font-mono">
                    {n.role === "app" ? "VPC-private" : (n.publicIp ?? "—")}
                  </td>
                  <td>
                    <div class="flex gap-1 justify-end flex-wrap items-center">
                      <a
                        href={`/clusters/${cluster}/nodes/${n.nodeId}/monitor`}
                        p-href={`/clusters/${cluster}/nodes/${n.nodeId}/monitor`}
                        p-target="content"
                        p-swap="monitor"
                        class="btn btn-ghost btn-xs lp-focus-ring"
                      >
                        Monitor
                      </a>
                      {running ? (
                        <form p-action="nodes:pause">
                          <ClusterField cluster={cluster} />
                          <input type="hidden" name="name" value={n.nodeId} />
                          <button class="btn btn-ghost btn-xs">Pause</button>
                        </form>
                      ) : (
                        <form p-action="nodes:resume">
                          <ClusterField cluster={cluster} />
                          <input type="hidden" name="name" value={n.nodeId} />
                          <button class="btn btn-ghost btn-xs">Resume</button>
                        </form>
                      )}
                      <form p-action="nodes:resize" class="flex items-center gap-1">
                        <ClusterField cluster={cluster} />
                        <input type="hidden" name="name" value={n.nodeId} />
                        <select name="instanceType" class="select select-bordered select-xs w-28">
                          {INSTANCE_TYPES.map((t) => (
                            <option value={t} selected={t === n.instanceType}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <button class="btn btn-ghost btn-xs">Resize</button>
                      </form>
                      <form
                        p-action="nodes:destroy"
                        data-confirm={`Destroy node ${n.nodeId}? This terminates the instance.`}
                      >
                        <ClusterField cluster={cluster} />
                        <input type="hidden" name="name" value={n.nodeId} />
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
  station.defineAction("nodes:create", {
    input: z.object({
      cluster: z.string().min(1),
      name: NAME_RULES,
      instanceType: z.string().min(1),
      role: z.enum(["edge", "app"]),
      edge: z.string().optional(),
    }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      const args = ["node", "create", data.name, "--instance-type", data.instanceType, "--role", data.role, "--yes"];
      if (data.role === "app" && data.edge && data.edge.trim()) args.push("--edge", data.edge.trim());
      try {
        await runLaunchPad(args, { cluster: data.cluster, profile: ctx.profile, region: ctx.region });
        flash(ctx, invalidate, "success", `Created node "${data.name}"`);
        broadcast("nodes:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Create failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });

  const simpleNodeAction = (
    key: string,
    verb: string,
    toArgs: (name: string) => string[],
  ) =>
    station.defineAction(key, {
      input: z.object({ cluster: z.string().min(1), name: z.string().min(1) }),
      handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
        try {
          await runLaunchPad(toArgs(data.name), {
            cluster: data.cluster,
            profile: ctx.profile,
            region: ctx.region,
          });
          flash(ctx, invalidate, "success", `${verb} node "${data.name}"`);
          broadcast("nodes:list");
          reply({ ok: true });
        } catch (err) {
          flash(ctx, invalidate, "error", `${verb} failed: ${errorMessage(err)}`);
          reply({ ok: false, error: errorMessage(err) });
        }
      },
    });

  simpleNodeAction("nodes:pause", "Paused", (name) => ["node", "pause", name]);
  simpleNodeAction("nodes:resume", "Resumed", (name) => ["node", "resume", name]);
  simpleNodeAction("nodes:destroy", "Destroyed", (name) => ["node", "destroy", name, "--yes"]);

  station.defineAction("nodes:resize", {
    input: z.object({
      cluster: z.string().min(1),
      name: z.string().min(1),
      instanceType: z.string().min(1),
    }),
    handler: async ({ data, ctx, broadcast, invalidate, reply }) => {
      try {
        await runLaunchPad(["node", "resize", data.name, "--instance-type", data.instanceType, "--yes"], {
          cluster: data.cluster,
          profile: ctx.profile,
          region: ctx.region,
        });
        flash(ctx, invalidate, "success", `Resized "${data.name}" → ${data.instanceType}`);
        broadcast("nodes:list");
        reply({ ok: true });
      } catch (err) {
        flash(ctx, invalidate, "error", `Resize failed: ${errorMessage(err)}`);
        reply({ ok: false, error: errorMessage(err) });
      }
    },
  });
}
