/**
 * `launchpad dashboard` — a local, READ-ONLY web viewer for clusters, nodes,
 * services, environments, history, live monitor, and live logs. It drives this
 * same CLI as a subprocess with `--json`, so it inherits the CLI's auth and
 * behavior exactly; it never mutates anything.
 *
 * Binding a non-loopback host requires LAUNCH_PAD_DASHBOARD_TOKEN (simple token
 * auth); localhost needs no auth. Project directories registered here (or the
 * cwd, when it holds a launch-pad.toml) let the dashboard resolve the `cwd`
 * that `logs` / `history` need.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { Command } from "commander";
import { parse as parseToml } from "smol-toml";
import { checkProjectDir, upsertProject } from "../../dashboard/app-config";
import { isLoopbackHost } from "../../dashboard/auth";
import { buildDashboardApp } from "../../dashboard/server";
import { wireRoomCleanup } from "../../dashboard/stream-registry";
import { CliError } from "../../errors";
import { applyGlobalOptions, mergedOpts, type GlobalOpts } from "../../globals";
import { log } from "../../ui/log";

interface DashboardOpts extends GlobalOpts {
  port?: string;
  host?: string;
  project?: string[];
  open?: boolean;
}

/** Register a project dir (name from its launch-pad.toml, falling back to basename). */
function registerProjectDir(dir: string): string | null {
  const abs = resolve(dir);
  const check = checkProjectDir(abs);
  if (!check.ok) return check.reason ?? "invalid project directory";
  let name = basename(abs);
  try {
    const parsed = parseToml(readFileSync(join(abs, "launch-pad.toml"), "utf8")) as { project?: unknown };
    if (typeof parsed.project === "string" && parsed.project.trim()) name = parsed.project.trim();
  } catch {
    /* unparseable toml — fall back to the directory name; the CLI will surface it */
  }
  upsertProject({ name, dir: abs });
  return null;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}

export function registerDashboard(program: Command): void {
  const cmd = program
    .command("dashboard")
    .description("run the read-only web dashboard (drives this CLI; never mutates)")
    .option("--port <port>", "listen port (default: PORT env or 4000)")
    .option("--host <host>", "bind interface (default: 127.0.0.1; non-localhost requires LAUNCH_PAD_DASHBOARD_TOKEN)")
    .option("--project <dir...>", "register project directory(ies) so logs/history can resolve a launch-pad.toml")
    .option("--no-open", "don't open the browser");
  applyGlobalOptions(cmd);

  cmd.action(async (_opts: unknown, command: Command) => {
    const opts = mergedOpts<DashboardOpts>(command);

    const port = Number(opts.port ?? process.env.PORT ?? 4000);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new CliError(`invalid port: ${opts.port ?? process.env.PORT}`);
    }
    const host = opts.host ?? process.env.LAUNCH_PAD_DASHBOARD_HOST ?? "127.0.0.1";
    const token = process.env.LAUNCH_PAD_DASHBOARD_TOKEN?.trim() || undefined;

    if (!isLoopbackHost(host) && !token) {
      throw new CliError(`refusing to bind ${host} without auth`, {
        hint: "set LAUNCH_PAD_DASHBOARD_TOKEN to enable token auth, or bind 127.0.0.1",
      });
    }

    // Launch-time project registration: explicit --project dirs, plus the cwd
    // when it holds a launch-pad.toml. The web UI itself never writes config.
    for (const dir of opts.project ?? []) {
      const problem = registerProjectDir(dir);
      if (problem) throw new CliError(`--project ${dir}: ${problem}`);
    }
    if (checkProjectDir(process.cwd()).ok) registerProjectDir(process.cwd());

    const app = buildDashboardApp({
      ctx: { cluster: opts.cluster, profile: opts.profile, region: opts.region },
      token,
    });

    wireRoomCleanup();

    await new Promise<void>((_resolve, reject) => {
      const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        const url = `http://${isLoopbackHost(host) ? "127.0.0.1" : host}:${info.port}`;
        log.info(`dashboard listening at ${url}${token ? "  (token auth on)" : ""}`);
        log.dim("  read-only — deploys and changes stay in the CLI");
        if (opts.open !== false && process.stderr.isTTY) openBrowser(url);
      });
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new CliError(`port ${port} is already in use`, { hint: "pass --port <other>" }));
        } else {
          reject(err);
        }
      });
      // Intentionally never resolves — the server runs until Ctrl-C.
    });
  });
}
