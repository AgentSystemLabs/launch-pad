/**
 * Monitor — live host + per-service CPU/memory for one node.
 *
 * The page shell server-renders the current fragment into a persistent
 * `[data-sse]` container; the SSE endpoint joins the shared room (one
 * `node monitor --watch` subprocess across all viewers) and re-renders the
 * same fragment on every sample. A paused/stopped node falls back to a
 * one-shot historic read (`--since 15m`) instead of a live watch.
 */
import { hostMemoryPercent } from "@agentsystemlabs/launch-pad-shared";
import type { Handler } from "hono";
import { runLaunchPad, streamLaunchPad } from "../cli-driver";
import { Breadcrumbs } from "../components/breadcrumbs";
import { MetricCard, Sparkline } from "../components/charts";
import { errorMessage } from "../components/feedback";
import { closedLine, mb, pct } from "../format";
import type { MonitorHistoricJson, StatsSample } from "../lp-types";
import { lpOpts, pageResponse, renderFragment, safeParam, type DashboardCtx } from "../render";
import { getRoomBuffer, getRoomClosed, monitorRoomKey, roomExists } from "../stream-registry";
import { sseRoomResponse } from "../sse";

/** Minimal `node show --json` view — only what the running-state probe reads. */
interface NodeShowProbe {
  node: { state: string };
  ec2: { state: string } | null;
}

function memPercent(s: StatsSample): number {
  return hostMemoryPercent(s.host);
}

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


function ServicesCard({ buffer }: { buffer: StatsSample[] }) {
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
  const last = buffer[buffer.length - 1];
  const latest = last ? serviceTotals(last) : new Map<string, { cpu: number; mem: number }>();

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
}

/** The live fragment — rendered into the page shell AND by every SSE frame. */
function MonitorFragment({ roomKey }: { roomKey: string }) {
  const buffer = getRoomBuffer<StatsSample>(roomKey);
  const closed = getRoomClosed(roomKey);

  if (buffer.length === 0) {
    return (
      <div class="card bg-base-200">
        <div class="card-body p-6 items-center text-center gap-2">
          {closed ? (
            <>
              <span class="text-warning font-medium" data-testid="monitor-ended">
                Stream ended
              </span>
              <span class="text-sm opacity-70 font-mono break-all">{closedLine(closed)}</span>
            </>
          ) : (
            <>
              <span class="loading loading-dots loading-md"></span>
              <span class="text-sm opacity-70" data-testid="monitor-waiting">
                waiting for samples…
              </span>
            </>
          )}
        </div>
      </div>
    );
  }

  const last = buffer[buffer.length - 1] as StatsSample;
  const cpuSeries = buffer.map((s) => s.host.cpuPercent);
  const memSeries = buffer.map(memPercent);
  return (
    <>
      {closed ? (
        <div class="alert alert-warning" role="status" data-testid="monitor-ended">
          <span>
            Stream ended: <span class="font-mono">{closedLine(closed)}</span>
          </span>
        </div>
      ) : null}
      <div class="grid md:grid-cols-2 gap-4">
        <MetricCard
          label="Host CPU"
          current={pct(last.host.cpuPercent)}
          percent={last.host.cpuPercent}
          values={cpuSeries}
        />
        <MetricCard
          label="Host Memory"
          current={`${mb(last.host.memoryUsedMb)} / ${mb(last.host.memoryTotalMb)}`}
          percent={memPercent(last)}
          values={memSeries}
        />
      </div>
      <ServicesCard buffer={buffer} />
    </>
  );
}

export function monitorPage(dctx: DashboardCtx): Handler {
  return (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    const node = safeParam(c.req.param("node"));
    if (!cluster || !node) return c.text("not found", 404);
    const key = monitorRoomKey(cluster, node);
    const sseUrl = `/events/monitor/${encodeURIComponent(cluster)}/${encodeURIComponent(node)}`;

    return pageResponse(c, { title: `Monitor · ${node}`, cluster, active: "nodes" }, (
      <div class="space-y-5">
        <Breadcrumbs
          items={[
            { label: "Clusters", href: "/clusters" },
            { label: cluster },
            { label: "Nodes", href: `/clusters/${encodeURIComponent(cluster)}/nodes` },
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

        {/* Persistent SSE target: frames replace its innerHTML; initial paint is
            the same fragment (live data if the room already exists). */}
        <div class="space-y-4" data-sse={sseUrl} data-testid="monitor-live">
          <MonitorFragment roomKey={key} />
        </div>
      </div>
    ));
  };
}

export function monitorSse(dctx: DashboardCtx): Handler {
  return async (c) => {
    const cluster = safeParam(c.req.param("cluster"));
    const node = safeParam(c.req.param("node"));
    if (!cluster || !node) return c.text("not found", 404);
    const key = monitorRoomKey(cluster, node);
    const opts = lpOpts(dctx, cluster);

    // Live --watch needs a running, SSM-managed instance; fall back to historic
    // (CloudWatch) for paused/stopped nodes so the page still shows recent data.
    // Only probe when this join would actually start the stream. The probe is
    // bounded (timeout + request signal): EventSource auto-reconnects, and an
    // unbounded hung probe per reconnect would pile up subprocesses.
    let running = true;
    if (!roomExists(key)) {
      try {
        const show = await runLaunchPad<NodeShowProbe>(["node", "show", node], {
          ...opts,
          timeoutMs: 10_000,
          signal: c.req.raw.signal,
        });
        running = (show.ec2?.state ?? show.node.state) === "running";
      } catch {
        if (c.req.raw.signal.aborted) return c.text("client gone", 408);
        running = true; // best-effort; assume running and let the stream surface errors
      }
    }

    return sseRoomResponse<StatsSample>(c, {
      key,
      max: 120,
      start: (push, onClose) => {
        if (running) {
          return streamLaunchPad(
            ["node", "monitor", node, "--watch", "--interval", "2"],
            (obj) => push(obj as StatsSample),
            { ...opts, onClose },
          );
        }
        // Historic one-shot: populate the buffer once, no live process.
        const abort = new AbortController();
        runLaunchPad<MonitorHistoricJson>(["node", "monitor", node, "--since", "15m"], {
          ...opts,
          signal: abort.signal,
        })
          .then((r) => {
            for (const sample of r.samples) push(sample);
            onClose({ code: 0, stderr: "node is not running — showing recent history" });
          })
          .catch((err) => onClose({ code: 1, stderr: errorMessage(err) }));
        return { stop: () => abort.abort() };
      },
      render: () => renderFragment(<MonitorFragment roomKey={key} />),
    });
  };
}
