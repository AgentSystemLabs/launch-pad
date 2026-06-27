import type { Station } from "@orbital-js/station";
import type { Database } from "bun:sqlite";
import type { AppCtx } from "../lib/ctx.ts";
import { listAgents, listWal, type WalEntry } from "../db/queries.ts";
import { eventBorder, timeAgo } from "../lib/ui.tsx";

export function registerWal(station: Station<AppCtx>, db: Database) {
  station.template("wal", ({ ctx }) => {
    const agents = listAgents(db).map((a) => a.id);
    return (
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-xl font-bold">Activity log (WAL)</h2>
          <select
            name="agent"
            class="select select-bordered select-sm"
            p-input-action="wal:filter"
            p-debounce="0"
          >
            <option value="" selected={!ctx.walFilter}>
              All agents
            </option>
            {agents.map((a) => (
              <option value={a} selected={ctx.walFilter === a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div id="wal-feed" p-template="wal-feed"></div>
      </div>
    );
  });

  station.template("wal-feed", ({ ctx }) => {
    const entries = listWal(db, {
      agent: ctx.walFilter ?? undefined,
      order: "asc",
      limit: 500,
    });
    // Stable root container so live morphs stay div→div (empty msg lives inside).
    return (
      <div class="stdout-scroll !max-h-[36rem] !font-sans !text-sm space-y-2" data-autoscroll>
        {entries.length === 0 ? (
          <div class="opacity-60 text-center py-12">No WAL entries yet.</div>
        ) : null}
        {entries.map((e: WalEntry) => (
          <article id={`wal-${e.id}`} class={`rounded-lg border-l-4 ${eventBorder(e.event)} bg-base-200 p-3`}>
            <div class="flex flex-wrap gap-x-3 gap-y-1 items-center text-xs opacity-70 mb-1">
              <span class="font-mono text-primary font-semibold">{e.agent}</span>
              <span class="badge badge-ghost badge-xs">{e.event}</span>
              {e.loop ? <span>loop: {e.loop}</span> : null}
              <span class="ml-auto">{timeAgo(e.ts)}</span>
            </div>
            <div class="whitespace-pre-wrap break-words">{e.summary}</div>
            {e.report ? (
              <div class="mt-2 pt-2 border-t border-dashed border-base-300 text-sm opacity-90 whitespace-pre-wrap">
                {e.report}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    );
  });

  station.action("wal:filter", ({ ctx, data, invalidate }) => {
    const agent = String((data as any)?.agent ?? "").trim();
    ctx.walFilter = agent || null;
    invalidate("wal-feed");
  });
}
