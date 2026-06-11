import type { Station } from "@orbital-js/station";
import { z } from "zod";
import type { AppCtx } from "../index";
import { streamLaunchPad } from "../lib/run-launch-pad";
import { joinRoom, leaveRoom, getRoomBuffer, getRoomClosed } from "../lib/stream-registry";
import { leaveCtxRooms, logsRoomKey } from "../lib/rooms";
import { getProject } from "../lib/app-config";
import { Breadcrumbs } from "../components/breadcrumbs";
import type { LogEventJson } from "../lib/lp-types";

function timeOnly(iso: string): string {
  const d = Date.parse(iso);
  return Number.isNaN(d) ? iso : new Date(d).toLocaleTimeString();
}

export function registerLogs(station: Station<AppCtx>) {
  station.template("logs", ({ params }) => {
    const cluster = params.cluster ?? "default";
    const project = params.project ?? "";
    const service = params.service ?? "";
    return (
      <div class="space-y-4">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/", swap: "clusters" },
            { label: cluster },
            { label: "Services", href: `/clusters/${cluster}/services`, swap: "services" },
            { label: `${project}/${service}` },
            { label: "Logs" },
          ]}
        />
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl font-bold">
            Logs <span class="font-mono opacity-70 text-lg">{project}/{service}</span>
          </h1>
          <span class="badge badge-ghost">{cluster}</span>
        </div>

        <div
          p-load="logs:start"
          data-cluster={cluster}
          data-project={project}
          data-service={service}
          hidden
        ></div>

        <div p-template="logs:lines"></div>
      </div>
    );
  });

  station.template("logs:lines", ({ params }) => {
    const cluster = params.cluster ?? "default";
    const project = params.project ?? "";
    const service = params.service ?? "";
    const key = logsRoomKey(cluster, project, service);
    const lines = getRoomBuffer<LogEventJson>(key);
    const closed = getRoomClosed(key);

    return (
      <div class="relative" data-logs-panel>
        <div
          data-testid="logs-output"
          data-logs-autoscroll=""
          class="mockup-code bg-base-300 text-sm max-h-[65vh] overflow-y-auto p-4"
        >
          {lines.length === 0 && !closed ? (
            <pre class="opacity-60">
              <code>waiting for log lines…</code>
            </pre>
          ) : (
            <></>
          )}
          {lines.map((e) => (
            <pre data-prefix="">
              <code>
                <span class="opacity-50">{timeOnly(e.timestamp)}</span>{" "}
                <span class="text-info">[{e.node ?? "?"}/{e.replica ?? 0}]</span> {e.message}
              </code>
            </pre>
          ))}
          {closed ? (
            <pre class="text-warning">
              <code>— stream ended: {closed.stderr.split("\n")[0] || `exit ${closed.code}`} —</code>
            </pre>
          ) : (
            <></>
          )}
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
    );
  });

  station.defineAction("logs:start", {
    input: z.object({
      cluster: z.string().min(1),
      project: z.string().min(1),
      service: z.string().min(1),
    }),
    handler: ({ data, ctx }) => {
      leaveCtxRooms(ctx);
      const { cluster, project, service } = data;
      ctx.liveLogs = { cluster, project, service };
      const key = logsRoomKey(cluster, project, service);
      const proj = getProject(project);

      const broadcast = () =>
        station.broadcast(
          "logs:lines",
          (c) =>
            c.liveLogs?.cluster === cluster &&
            c.liveLogs?.project === project &&
            c.liveLogs?.service === service,
        );

      joinRoom<LogEventJson>({
        key,
        max: 500,
        onUpdate: broadcast,
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
            { cwd: proj.dir, cluster, profile: ctx.profile, region: ctx.region, onClose },
          );
        },
      });
    },
  });

  station.defineAction("logs:stop", {
    handler: ({ ctx }) => {
      if (ctx.liveLogs) {
        leaveRoom(logsRoomKey(ctx.liveLogs.cluster, ctx.liveLogs.project, ctx.liveLogs.service));
        ctx.liveLogs = undefined;
      }
    },
  });
}
