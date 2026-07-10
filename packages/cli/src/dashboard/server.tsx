/**
 * The dashboard's Hono app: a read-only web viewer that drives this same CLI as a
 * subprocess (`--json` / `--follow`) and renders the output. No route mutates
 * anything — deploys/creates/destroys happen via the CLI, agents, or CI.
 *
 * Route map:
 *   GET /                                        overview health rollup
 *   GET /clusters                                cluster list
 *   GET /projects                                registered project dirs
 *   GET /projects/:project/history               deploy history (needs registered dir)
 *   GET /clusters/:cluster/nodes                 node list
 *   GET /clusters/:cluster/services              services aggregated from status
 *   GET /clusters/:cluster/environments          env markers (deploy --env)
 *   GET /clusters/:cluster/nodes/:node/monitor   live CPU/memory (SSE)
 *   GET /clusters/:cluster/logs/:project/:service  live log tail (SSE)
 *   GET /events/monitor/:cluster/:node           SSE feed for monitor
 *   GET /events/logs/:cluster/:project/:service  SSE feed for logs
 *   GET /dashboard.css, /healthz
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { clustersPage } from "./pages/clusters";
import { environmentsPage } from "./pages/environments";
import { historyPage } from "./pages/history";
import { logsPage, logsSse } from "./pages/logs";
import { monitorPage, monitorSse } from "./pages/monitor";
import { nodesPage } from "./pages/nodes";
import { overviewPage } from "./pages/overview";
import { projectsPage } from "./pages/projects";
import { servicesPage } from "./pages/services";
import { navCluster, pageResponse, type DashboardCtx } from "./render";

/** Locate the prebuilt stylesheet: sibling of the bundled entry (published), or
 * the package dist/ when running from source via tsx. */
function resolveCss(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "dashboard.css"), // dist/index.js + dist/dashboard.css (published bundle)
    join(here, "..", "..", "dist", "dashboard.css"), // src/dashboard/* via tsx
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface BuildAppOpts {
  ctx: DashboardCtx;
  /** LAUNCH_PAD_DASHBOARD_TOKEN — presence turns on auth for every page */
  token?: string;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  // Stop MIME sniffing on the CSS/text routes (content-type confusion).
  "X-Content-Type-Options": "nosniff",
  // Never leak the URL (which can carry a bootstrap `?token=`) to linked/CSS origins.
  "Referrer-Policy": "no-referrer",
} as const;

export function buildDashboardApp(opts: BuildAppOpts): Hono {
  const { ctx } = opts;
  const app = new Hono();

  // Set security headers BEFORE the handler runs. A streamed SSE response flushes its
  // headers as soon as the handler starts writing, so setting them after `next()` would
  // skip every live monitor/log stream — the long-lived responses that most want them.
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }
    await next();
  });
  if (opts.token) app.use("*", authMiddleware(opts.token));

  app.get("/healthz", (c) => c.json({ ok: true }));

  const cssPath = resolveCss();
  app.get("/dashboard.css", (c) => {
    if (!cssPath) return c.text("/* dashboard.css missing — run `pnpm build:css` */", 200, { "content-type": "text/css" });
    return c.body(readFileSync(cssPath, "utf8"), 200, {
      "content-type": "text/css",
      "cache-control": "max-age=300",
    });
  });

  app.get("/", overviewPage(ctx));
  app.get("/clusters", clustersPage(ctx));
  app.get("/projects", projectsPage(ctx));
  app.get("/projects/:project/history", historyPage(ctx));
  app.get("/clusters/:cluster/nodes", nodesPage(ctx));
  app.get("/clusters/:cluster/services", servicesPage(ctx));
  app.get("/clusters/:cluster/environments", environmentsPage(ctx));
  app.get("/clusters/:cluster/nodes/:node/monitor", monitorPage(ctx));
  app.get("/clusters/:cluster/logs/:project/:service", logsPage(ctx));
  app.get("/events/monitor/:cluster/:node", monitorSse(ctx));
  app.get("/events/logs/:cluster/:project/:service", logsSse(ctx));

  // Any page/render bug must still yield the dashboard's ErrorCard chrome, not
  // Hono's bare 500 text.
  app.onError(async (err, c) => {
    const res = await pageResponse(c, { title: "Error", cluster: navCluster(ctx), active: "none" }, (
      <div class="alert alert-error" role="alert">
        <div>
          <div class="font-semibold">Something went wrong rendering this page</div>
          <div class="text-sm opacity-90 font-mono break-all">
            {err instanceof Error ? err.message : String(err)}
          </div>
        </div>
      </div>
    ));
    return new Response(res.body, { status: 500, headers: res.headers });
  });

  app.notFound((c) =>
    pageResponse(c, { title: "Not found", cluster: navCluster(ctx), active: "none" }, (
      <div class="text-center py-12 opacity-70">
        <div class="text-lg font-medium">Page not found</div>
        <a href="/" class="link link-hover text-sm">
          Back to overview
        </a>
      </div>
    )),
  );

  return app;
}
