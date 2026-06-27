import type { Station } from "@orbital-js/station";
import type { Database } from "bun:sqlite";
import type { AppCtx } from "../lib/ctx.ts";
import { getAgent, tailStdout } from "../db/queries.ts";
import { statusBadge, timeAgo } from "../lib/ui.tsx";

export function registerAgent(station: Station<AppCtx>, db: Database) {
  station.template("agent-detail", ({ params }) => {
    const id = params.id ?? "";
    return (
      <div class="space-y-4">
        {/* Records which agent this socket is viewing → drives stdout broadcasts. */}
        <div p-load="agent:view" data-id={id} hidden></div>
        <a href="/" p-href="/" p-target="content" class="link link-hover text-sm opacity-70">
          ← back to dashboard
        </a>
        <h2 class="text-2xl font-bold font-mono">{id}</h2>

        <div class="card bg-base-200">
          <div class="card-body py-4">
            <h3 class="card-title text-base">Current task</h3>
            <div id="agent-task" p-template="agent-task"></div>
          </div>
        </div>

        <div class="card bg-base-200">
          <div class="card-body py-4">
            <h3 class="card-title text-base">Live output</h3>
            <div id="agent-stdout" p-template="agent-stdout"></div>
          </div>
        </div>
      </div>
    );
  });

  station.template("agent-task", ({ ctx, params }) => {
    const id = params.id ?? ctx.viewingAgent ?? "";
    const agent = getAgent(db, id);
    if (!agent) return <div class="opacity-60">No data for this agent yet.</div>;
    return (
      <div class="flex flex-wrap gap-x-6 gap-y-2 items-center text-sm">
        <span>{statusBadge(agent.status)}</span>
        <span>
          loop: <span class="font-mono">{agent.currentLoop ?? "—"}</span>
        </span>
        <span class="opacity-80">{agent.currentSummary ?? "—"}</span>
        <span class="ml-auto opacity-60 text-xs">last seen {timeAgo(agent.lastSeen)}</span>
      </div>
    );
  });

  station.template("agent-stdout", ({ ctx, params }) => {
    const id = params.id ?? ctx.viewingAgent ?? "";
    const lines = tailStdout(db, id, 500);
    // Stable root container so live morphs stay div→div.
    return (
      <div class="stdout-scroll" data-autoscroll>
        {lines.length === 0 ? <div class="opacity-60">waiting for output…</div> : null}
        {lines.map((l) => (
          <div id={`out-${l.id}`} class="whitespace-pre-wrap break-words">
            {l.line}
          </div>
        ))}
      </div>
    );
  });

  station.action("agent:view", ({ ctx, data, invalidate }) => {
    const id = String((data as any)?.id ?? "").trim();
    ctx.viewingAgent = id || null;
    invalidate("agent-task");
    invalidate("agent-stdout");
  });
}
