/** Environments — the cluster's `deploy --env` preview markers, read via
 * `destroy --list-envs --json` (each marker plus a computed `expired` flag). */
import type { Handler } from "hono";
import { runLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import { ago } from "../format";
import type { EnvListJson, EnvListEntry } from "../lp-types";
import { lpOpts, pageResponse, safeParam, type DashboardCtx } from "../render";

/** "in 3h" countdown to an ISO deadline (0-floored — expired shows a badge instead). */
function untilLabel(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((t - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function ExpiryCell({ env }: { env: EnvListEntry }) {
  if (env.expiresAt === null) return <span class="opacity-60">no TTL</span>;
  if (env.expired) return <span class="badge badge-error badge-sm">expired</span>;
  return (
    <span class="tabular-nums" title={env.expiresAt}>
      {untilLabel(env.expiresAt)}
    </span>
  );
}

export function environmentsPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    if (!cluster) return c.text("not found", 404);
    const meta = { title: "Environments", cluster, active: "environments" as const };
    const crumbs = (
      <Breadcrumbs
        items={[{ label: "Clusters", href: "/clusters" }, { label: cluster }, { label: "Environments" }]}
      />
    );

    let data: EnvListJson;
    try {
      data = await runLaunchPad<EnvListJson>(["destroy", "--list-envs"], lpOpts(dctx, cluster));
    } catch (err) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <ErrorCard title="Couldn't list environments" message={errorMessage(err)} />
        </div>,
      );
    }

    if (!data || data.envs.length === 0) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <EmptyState
            title="No environments"
            message="Create one with `launchpad deploy --env <name>` (add `--ttl 72h` for auto-expiry)."
          />
        </div>,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        {crumbs}
        <h1 class="text-xl font-semibold">Environments</h1>
        <div class="overflow-x-auto">
          <table class="table table-zebra" data-testid="environments-table">
            <thead>
              <tr>
                <th>Env</th>
                <th>Project</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Domains</th>
              </tr>
            </thead>
            <tbody>
              {data.envs.map((env) => (
                <tr data-testid={`env-row-${env.owner}`}>
                  <td class="font-mono font-semibold">{env.env}</td>
                  <td class="font-mono">
                    {env.project}
                    {env.component !== undefined ? <span class="opacity-60">/{env.component}</span> : null}
                  </td>
                  <td class="text-sm opacity-80" title={env.createdAt}>
                    {ago(env.createdAt)}
                  </td>
                  <td class="text-sm">
                    <ExpiryCell env={env} />
                  </td>
                  <td class="font-mono text-xs opacity-70 break-all">
                    {env.domains.length > 0 ? env.domains.join(", ") : "—"}
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
