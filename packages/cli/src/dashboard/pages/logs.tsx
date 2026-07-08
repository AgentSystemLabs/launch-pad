/**
 * Logs — live log tail for one project/service.
 *
 * The page shell server-renders the current lines into a persistent scroll
 * container that is both the `[data-sse]` swap target and the
 * `[data-logs-autoscroll]` element (it persists across innerHTML swaps, so the
 * autoscroll MutationObserver keeps working). The SSE endpoint joins the shared
 * room (one `logs --follow` subprocess across all viewers). `launch-pad logs`
 * resolves the project from launch-pad.toml in cwd, so it needs a registered
 * project directory — unregistered projects get a hint, never a subprocess.
 */
import type { Handler } from "hono";
import { getProject } from "../app-config";
import { streamLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { closedLine } from "../format";
import type { LogEventJson } from "../lp-types";
import { lpOpts, pageResponse, renderFragment, safeParam, type DashboardCtx } from "../render";
import { getRoomBuffer, getRoomClosed, logsRoomKey } from "../stream-registry";
import { sseRoomResponse } from "../sse";

function timeOnly(iso: string): string {
  const d = Date.parse(iso);
  return Number.isNaN(d) ? iso : new Date(d).toLocaleTimeString();
}

/** The live fragment — rendered into the page shell AND by every SSE frame. */
function LogsFragment({ roomKey }: { roomKey: string }) {
  const lines = getRoomBuffer<LogEventJson>(roomKey);
  const closed = getRoomClosed(roomKey);

  return (
    <>
      {lines.length === 0 && !closed ? (
        <pre class="opacity-60" data-testid="logs-waiting">
          <code>waiting for log events…</code>
        </pre>
      ) : null}
      {lines.map((e) => (
        <pre data-prefix="">
          <code>
            <span class="opacity-50">{timeOnly(e.timestamp)}</span>{" "}
            <span class="text-info">
              [{e.node ?? "?"}/{e.replica ?? 0}]
            </span>{" "}
            {e.message}
          </code>
        </pre>
      ))}
      {closed ? (
        <pre class="text-warning" data-testid="logs-ended">
          <code>— stream ended: {closedLine(closed)} —</code>
        </pre>
      ) : null}
    </>
  );
}

export function logsPage(dctx: DashboardCtx): Handler {
  return (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    const project = safeParam(c.req.param("project"));
    const service = safeParam(c.req.param("service"));
    if (!cluster || !project || !service) return c.text("not found", 404);
    const key = logsRoomKey(cluster, project, service);
    const sseUrl = `/events/logs/${encodeURIComponent(cluster)}/${encodeURIComponent(project)}/${encodeURIComponent(service)}`;

    return pageResponse(c, { title: `Logs · ${project}/${service}`, cluster, active: "services" }, (
      <div class="space-y-4">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/clusters" },
            { label: cluster },
            { label: "Services", href: `/clusters/${encodeURIComponent(cluster)}/services` },
            { label: `${project}/${service}` },
            { label: "Logs" },
          ]}
        />
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl font-bold">
            Logs{" "}
            <span class="font-mono opacity-70 text-lg">
              {project}/{service}
            </span>
          </h1>
          <span class="badge badge-ghost">{cluster}</span>
        </div>

        <div class="relative" data-logs-panel data-testid="logs-panel">
          {/* Persistent scroll container: SSE swap target + autoscroll element.
              The jump button lives OUTSIDE it so innerHTML swaps never remove it. */}
          <div
            data-testid="logs-output"
            data-logs-autoscroll=""
            data-sse={sseUrl}
            class="mockup-code bg-base-300 text-sm h-[60vh] overflow-y-auto p-4"
          >
            <LogsFragment roomKey={key} />
          </div>
          <button
            type="button"
            data-logs-jump
            data-testid="logs-jump"
            class="btn btn-primary btn-sm absolute bottom-3 right-3 shadow-lg hidden"
            aria-label="Jump to latest"
          >
            ↓ Latest
          </button>
        </div>
      </div>
    ));
  };
}

export function logsSse(dctx: DashboardCtx): Handler {
  return (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    const project = safeParam(c.req.param("project"));
    const service = safeParam(c.req.param("service"));
    if (!cluster || !project || !service) return c.text("not found", 404);
    const key = logsRoomKey(cluster, project, service);
    const opts = lpOpts(dctx, cluster);
    const proj = getProject(project);

    return sseRoomResponse<LogEventJson>(c, {
      key,
      max: 500,
      start: (push, onClose) => {
        // `launch-pad logs` resolves the project from launch-pad.toml in cwd, so a
        // registered project directory is required to tail its logs.
        if (!proj) {
          onClose({
            code: 1,
            stderr: `project "${project}" isn't registered — add it on the Projects page to view logs`,
          });
          return { stop: () => {} };
        }
        return streamLaunchPad(
          ["logs", service, "--follow", "--tail", "200"],
          (obj) => push(obj as LogEventJson),
          { cwd: proj.dir, ...opts, onClose },
        );
      },
      render: () => renderFragment(<LogsFragment roomKey={key} />),
    });
  };
}
