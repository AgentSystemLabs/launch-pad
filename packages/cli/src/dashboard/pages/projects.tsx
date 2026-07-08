/** Projects — the operator's registered project directories (dashboard-local
 * state, registered at launch time via `--project`). Read-only: shows each dir's
 * health and links into History + per-service Logs; no register/deploy/env forms. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Handler } from "hono";
import { parse as parseToml } from "smol-toml";
import { listProjects, checkProjectDir } from "../app-config";
import { Breadcrumbs } from "../components/breadcrumbs";
import { EmptyState } from "../components/feedback";
import { navCluster, pageResponse, type DashboardCtx } from "../render";

interface TomlSummary {
  /** The TOML `project` field (the footprint owner used in logs URLs). */
  project: string | null;
  /** `[[service]]` names, in file order. */
  services: string[];
}

/** Best-effort launch-pad.toml read for links — any failure yields no services. */
function readTomlSummary(dir: string): TomlSummary {
  try {
    const parsed = parseToml(readFileSync(join(dir, "launch-pad.toml"), "utf8")) as Record<string, unknown>;
    const project = typeof parsed.project === "string" ? parsed.project : null;
    const services = Array.isArray(parsed.service)
      ? parsed.service.flatMap((s) =>
          s !== null && typeof s === "object" && typeof (s as Record<string, unknown>).name === "string"
            ? [(s as Record<string, unknown>).name as string]
            : [],
        )
      : [];
    return { project, services };
  } catch {
    return { project: null, services: [] };
  }
}

export function projectsPage(dctx: DashboardCtx): Handler {
  return (c) => {
    const cluster = navCluster(dctx);
    const meta = { title: "Projects", cluster, active: "projects" as const };
    const projects = listProjects();

    if (projects.length === 0) {
      return pageResponse(
        c,
        meta,
        <EmptyState
          title="No projects registered"
          message="Run `launchpad dashboard --project <dir>` (or launch from a project directory) to register one."
        />,
      );
    }

    return pageResponse(
      c,
      meta,
      <div class="space-y-4">
        <Breadcrumbs items={[{ label: "Clusters", href: "/clusters" }, { label: "Projects" }]} />
        <h1 class="text-xl font-semibold">Projects</h1>
        <div class="overflow-x-auto">
          <table class="table table-zebra" data-testid="projects-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Directory</th>
                <th>Cluster</th>
                <th>Status</th>
                <th class="text-right">Links</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const dir = checkProjectDir(p.dir);
                const toml = dir.ok ? readTomlSummary(p.dir) : { project: null, services: [] };
                const logsCluster = p.cluster ?? cluster;
                const logsProject = toml.project ?? p.name;
                return (
                  <tr data-testid={`project-row-${p.name}`}>
                    <td>
                      <span data-testid={`project-name-${p.name}`} class="font-mono font-semibold">
                        {p.name}
                      </span>
                    </td>
                    <td>
                      <div class="flex items-center gap-2">
                        <span data-testid={`project-dir-${p.name}`} class="font-mono text-xs opacity-70 break-all">
                          {p.dir}
                        </span>
                        <button type="button" data-copy-path={p.dir} class="btn btn-ghost btn-xs">
                          copy
                        </button>
                      </div>
                    </td>
                    <td class="opacity-80">{p.cluster ?? "default"}</td>
                    <td>
                      {dir.ok ? (
                        <span class="badge badge-success badge-sm" data-testid={`project-dir-ok-${p.name}`}>
                          ok
                        </span>
                      ) : (
                        <span
                          class="badge badge-error badge-sm"
                          data-testid={`project-dir-error-${p.name}`}
                          title={dir.reason}
                        >
                          {dir.reason}
                        </span>
                      )}
                    </td>
                    <td class="text-right whitespace-nowrap">
                      <a class="link link-hover mr-3 lp-focus-ring rounded-sm" href={`/projects/${p.name}/history`}>
                        History
                      </a>
                      {toml.services.map((svc) => (
                        <a
                          class="link link-hover mr-3 last:mr-0 lp-focus-ring rounded-sm"
                          data-testid={`project-logs-${p.name}-${svc}`}
                          href={`/clusters/${logsCluster}/logs/${logsProject}/${svc}`}
                        >
                          Logs: {svc}
                        </a>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>,
    );
  };
}
