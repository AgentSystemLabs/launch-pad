import type { Station } from "@orbital-js/station";
import { hostMemoryPercent } from "@agentsystemlabs/launch-pad-shared";
import { z } from "zod";
import type { AppCtx } from "../index";
import { runLaunchPad, streamLaunchPad } from "../lib/run-launch-pad";
import { joinRoom, leaveRoom, getRoomBuffer, getRoomClosed } from "../lib/stream-registry";
import { leaveCtxRooms, monitorRoomKey } from "../lib/rooms";
import { MetricCard, Sparkline } from "../components/charts";
import { Breadcrumbs } from "../components/breadcrumbs";
import { mb, pct } from "../lib/format";
import { errorMessage } from "../components/feedback";
import type { StatsSample, MonitorHistoricJson, NodeShowJson } from "../lib/lp-types";

/** Sum a service's cpu% / memory across its replicas in one sample. */
function serviceTotals(s: StatsSample): Map<string, { cpu: number; mem: number }> {
  const m = new Map<string, { cpu: number; mem: number }>();
  for (const svc of s.services) {
    const key = `${svc.project}/${svc.service}`;
    const cur = m.get(key) ?? { cpu: 0, mem: 0 };
    cur.cpu += svc.cpuPercent;
    cur.mem += svc.memoryUsedMb;
    m.set(key, cur);
  }
  return m;
}

export function registerMonitor(station: Station<AppCtx>) {
  station.template("monitor", ({ params }) => {
    const cluster = params.cluster ?? "default";
    const node = params.node ?? "";
    return (
      <div class="space-y-5">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/", swap: "clusters" },
            { label: cluster },
            { label: "Nodes", href: `/clusters/${cluster}/nodes`, swap: "nodes" },
            { label: node },
            { label: "Monitor" },
          ]}
        />
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-2xl font-bold">
            Monitor <span class="font-mono opacity-70 text-lg">{node}</span>
          </h1>
          <span class="badge badge-ghost">{cluster}</span>
        </div>

        {/* p-load starts the shared stream; data-* are forwarded to the action */}
        <div p-load="monitor:start" data-cluster={cluster} data-node={node} hidden></div>

        <div class="grid md:grid-cols-2 gap-4">
          <div p-template="monitor:host"></div>
        </div>
        <div p-template="monitor:services"></div>
      </div>
    );
  });

  station.template("monitor:host", ({ params }) => {
    const cluster = params.cluster ?? "default";
    const node = params.node ?? "";
    const key = monitorRoomKey(cluster, node);
    const buffer = getRoomBuffer<StatsSample>(key);
    const closed = getRoomClosed(key);

    if (buffer.length === 0) {
      return (
        <div class="card bg-base-200 md:col-span-2">
          <div class="card-body p-6 items-center text-center gap-2">
            {closed ? (
              <>
                <span class="text-warning font-medium">Stream ended</span>
                <span class="text-sm opacity-70 font-mono break-all">
                  {closed.stderr.split("\n")[0] || `exit ${closed.code}`}
                </span>
              </>
            ) : (
              <>
                <span class="loading loading-dots loading-md"></span>
                <span class="text-sm opacity-70">waiting for samples…</span>
              </>
            )}
          </div>
        </div>
      );
    }

    const last = buffer[buffer.length - 1] as StatsSample;
    const cpuSeries = buffer.map((s) => s.host.cpuPercent);
    const memSeries = buffer.map((s) => hostMemoryPercent(s.host));
    return (
      <>
        <MetricCard label="Host CPU" current={pct(last.host.cpuPercent)} percent={last.host.cpuPercent} values={cpuSeries} />
        <MetricCard
          label="Host Memory"
          current={`${mb(last.host.memoryUsedMb)} / ${mb(last.host.memoryTotalMb)}`}
          percent={hostMemoryPercent(last.host)}
          values={memSeries}
        />
      </>
    );
  });

  station.template("monitor:services", ({ params }) => {
    const cluster = params.cluster ?? "default";
    const node = params.node ?? "";
    const buffer = getRoomBuffer<StatsSample>(monitorRoomKey(cluster, node));
    if (buffer.length === 0) return <></>;

    // Build a cpu time-series per service across the whole buffer.
    const names = new Set<string>();
    const series = new Map<string, number[]>();
    for (const sample of buffer) {
      const totals = serviceTotals(sample);
      for (const [name, t] of totals) {
        names.add(name);
        const arr = series.get(name) ?? [];
        arr.push(t.cpu);
        series.set(name, arr);
      }
    }
    const latest = serviceTotals(buffer[buffer.length - 1] as StatsSample);

    if (names.size === 0) {
      return <div class="opacity-60 text-sm">No service-level stats on this node.</div>;
    }

    return (
      <div class="card bg-base-200">
        <div class="card-body p-4 gap-2">
          <h2 class="font-semibold">Services</h2>
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Service</th>
                <th>CPU</th>
                <th>Memory</th>
                <th class="w-40">CPU trend</th>
              </tr>
            </thead>
            <tbody>
              {[...names].map((name) => {
                const cur = latest.get(name) ?? { cpu: 0, mem: 0 };
                return (
                  <tr data-testid={`monitor-svc-${name.replace("/", "-")}`}>
                    <td class="font-mono text-sm">{name}</td>
                    <td>{pct(cur.cpu)}</td>
                    <td>{mb(cur.mem)}</td>
                    <td>
                      <Sparkline values={series.get(name) ?? []} max={100} width={160} height={28} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  });

  // ── start/stop ────────────────────────────────────────────────────────────────
  station.defineAction("monitor:start", {
    input: z.object({ cluster: z.string().min(1), node: z.string().min(1) }),
    handler: async ({ data, ctx }) => {
      // reset-then-join: leave any room this socket already had (race-free nav)
      leaveCtxRooms(ctx);
      const { cluster, node } = data;
      ctx.liveMonitor = { cluster, node };
      const key = monitorRoomKey(cluster, node);

      // Live --watch needs a running, SSM-managed instance; fall back to historic
      // (CloudWatch) for paused/stopped nodes so the page still shows recent data.
      let running = true;
      try {
        const show = await runLaunchPad<NodeShowJson>(["node", "show", node], {
          cluster,
          profile: ctx.profile,
          region: ctx.region,
        });
        running = (show.ec2?.state ?? show.node.state) === "running";
      } catch {
        running = true; // best-effort; assume running and let the stream surface errors
      }

      const broadcast = () => {
        station.broadcast("monitor:host", (c) => c.liveMonitor?.cluster === cluster && c.liveMonitor?.node === node);
        station.broadcast("monitor:services", (c) => c.liveMonitor?.cluster === cluster && c.liveMonitor?.node === node);
      };

      joinRoom<StatsSample>({
        key,
        max: 120,
        onUpdate: broadcast,
        start: (push, onClose) => {
          if (running) {
            return streamLaunchPad(
              ["node", "monitor", node, "--watch", "--interval", "2"],
              (obj) => push(obj as StatsSample),
              { cluster, profile: ctx.profile, region: ctx.region, onClose },
            );
          }
          // Historic one-shot: populate the buffer once, no live process.
          runLaunchPad<MonitorHistoricJson>(["node", "monitor", node, "--since", "15m"], {
            cluster,
            profile: ctx.profile,
            region: ctx.region,
          })
            .then((r) => r.samples.forEach(push))
            .catch((err) => onClose({ code: 1, stderr: errorMessage(err) }));
          return { stop: () => {} };
        },
      });
    },
  });

  station.defineAction("monitor:stop", {
    handler: ({ ctx }) => {
      if (ctx.liveMonitor) {
        leaveRoom(monitorRoomKey(ctx.liveMonitor.cluster, ctx.liveMonitor.node));
        ctx.liveMonitor = undefined;
      }
    },
  });
}
