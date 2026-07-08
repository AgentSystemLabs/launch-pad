/** History — a registered project's append-only deploy events (`launchpad history`,
 * run with the project's directory as cwd so the CLI can resolve launch-pad.toml). */
import type { Handler } from "hono";
import { getProject } from "../app-config";
import { runLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { ErrorCard, EmptyState, errorMessage } from "../components/feedback";
import { ago } from "../format";
import type { HistoryJson } from "../lp-types";
import { navCluster, lpOpts, pageResponse, type DashboardCtx } from "../render";

/** The immutable tag portion of an image URI (after the last `:`), or the URI itself. */
function imageTag(image: string): string {
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? image.slice(colon + 1) : image;
}

const KIND_BADGE: Record<string, string> = {
  build: "badge-primary badge-outline",
  restart: "badge-warning badge-outline",
  image: "badge-info badge-outline",
  migrate: "badge-secondary badge-outline",
};

export function historyPage(dctx: DashboardCtx): Handler {
  return async (c) => {
    const name = c.req.param("project") ?? "";
    const cluster = navCluster(dctx);
    const meta = { title: `History · ${name}`, cluster, active: "projects" as const };
    const crumbs = (
      <Breadcrumbs items={[{ label: "Projects", href: "/projects" }, { label: name }, { label: "History" }]} />
    );

    const proj = getProject(name);
    if (!proj) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <ErrorCard
            title={`Project "${name}" isn't registered`}
            message="Register it at launch: `launchpad dashboard --project <dir>` (or start the dashboard from the project directory)."
          />
        </div>,
      );
    }

    let data: HistoryJson;
    try {
      data = await runLaunchPad<HistoryJson>(["history"], { ...lpOpts(dctx, proj.cluster), cwd: proj.dir });
    } catch (err) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <ErrorCard title="Couldn't load history" message={errorMessage(err)} />
        </div>,
      );
    }

    if (!data || data.events.length === 0) {
      return pageResponse(
        c,
        meta,
        <div class="space-y-4">
          {crumbs}
          <EmptyState title="No deploys yet" message="Deploy this project (`launchpad deploy`) to record its first event." />
        </div>,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        {crumbs}
        <h1 class="text-xl font-semibold">
          History · <span class="font-mono">{data.project}</span>
        </h1>
        <div class="overflow-x-auto">
          <table class="table table-zebra" data-testid="history-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Services</th>
                <th>Image tag</th>
                <th>Env</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((ev, idx) => (
                <tr data-testid={`history-row-${idx}`}>
                  <td class="text-sm whitespace-nowrap" title={ev.at}>
                    {ago(ev.at)}
                  </td>
                  <td>
                    <span class={`badge badge-sm ${KIND_BADGE[ev.kind] ?? "badge-ghost"}`}>{ev.kind}</span>
                  </td>
                  <td class="font-mono text-sm">
                    {ev.services.map((s) => (
                      <div>
                        {s.service}
                        {s.replicas > 0 ? <span class="opacity-60"> ×{s.replicas}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td class="font-mono text-xs opacity-70">
                    {ev.services.map((s) => (
                      <div title={s.image}>{imageTag(s.image)}</div>
                    ))}
                  </td>
                  <td class="font-mono text-sm opacity-80">{ev.env ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>,
    );
  };
}
