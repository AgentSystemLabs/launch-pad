import type { Station } from "@orbital-js/station";
import type { Database } from "bun:sqlite";
import type { AppCtx } from "../lib/ctx.ts";
import type { Notify } from "../api/routes.ts";
import {
  armRun,
  getActiveMission,
  getControl,
  getDraft,
  listAgents,
  markAllAgents,
  setDraft,
  setPaused,
  appendWal,
  type AgentRow,
} from "../db/queries.ts";
import { timeAgo, statusBadge, flash } from "../lib/ui.tsx";

export function registerDashboard(station: Station<AppCtx>, db: Database, notify: Notify) {
  station.template("dashboard", () => (
    <div class="space-y-6">
      <div id="mission-panel" p-template="mission-panel"></div>
      <div>
        <h2 class="text-xl font-bold mb-2">Agents</h2>
        <div id="agents-grid" p-template="agents-grid"></div>
      </div>
    </div>
  ));

  station.template("mission-panel", () => {
    const control = getControl(db);
    const active = getActiveMission(db);
    const draft = getDraft(db);
    const prefill = active?.body ?? draft ?? "";
    return (
      <div class="card bg-base-200 shadow">
        <div class="card-body gap-3">
          <div class="flex items-center justify-between">
            <h2 class="card-title">Mission</h2>
            {active ? (
              <span class="badge badge-success gap-1">armed · #{active.id}</span>
            ) : (
              <span class="badge badge-ghost">no active mission</span>
            )}
          </div>

          {active ? (
            <div class="rounded-lg bg-base-300/50 p-3 text-sm whitespace-pre-wrap">{active.body}</div>
          ) : (
            <p class="text-sm opacity-70">
              Agents sleep until you set a mission and click <b>Run</b>.
            </p>
          )}

          {/* Draft form. NOTE: station.js ignores p-click-action on a button
              INSIDE a p-action form, so the Run button lives outside it. */}
          <form p-action="mission:draft" class="space-y-2" p-action-scope="any">
            <textarea
              name="body"
              class="textarea textarea-bordered w-full h-32 font-mono text-sm"
              placeholder="Describe the mission: high-level goal, constraints, links. e.g. 'Improve the coffee-shop UX and fix multiplayer bugs — small PRs only.'"
            >
              {prefill}
            </textarea>
            <div class="flex gap-2 items-center">
              <button type="submit" class="btn btn-neutral btn-sm">
                Set mission
              </button>
              <span class="text-success text-sm" p-action-success hidden></span>
              <span class="text-error text-sm" p-action-error hidden></span>
            </div>
          </form>
          <div class="flex gap-2 items-center">
            <button class="btn btn-primary btn-sm" p-click-action="swarm:run">
              Run ▶
            </button>
            <span class="text-xs opacity-60">
              state: {control.state}
              {control.paused ? " · paused" : ""}
            </span>
          </div>
        </div>
      </div>
    );
  });

  station.template("agents-grid", () => {
    const agents = listAgents(db);
    // Stable root (always this table) so live morphs are table→table — never
    // swap the region's root element type, which morphdom can't reconcile.
    return (
      <div class="overflow-x-auto">
        <table class="table table-zebra table-sm">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Loop</th>
              <th>Doing</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 ? (
              <tr>
                <td colspan={5} class="text-center opacity-60 py-8">
                  No agents have checked in yet. Deploy the <code>engineer</code> service and they’ll
                  appear here.
                </td>
              </tr>
            ) : null}
            {agents.map((a: AgentRow) => (
              <tr id={`agent-row-${a.id}`} class="hover">
                <td>
                  <a
                    href={`/agents/${encodeURIComponent(a.id)}`}
                    p-href={`/agents/${encodeURIComponent(a.id)}`}
                    p-target="content"
                    class="link link-primary font-mono"
                  >
                    {a.id}
                  </a>
                </td>
                <td>{statusBadge(a.status)}</td>
                <td class="font-mono text-xs">{a.currentLoop ?? "—"}</td>
                <td class="max-w-xs truncate text-sm opacity-80">{a.currentSummary ?? "—"}</td>
                <td class="text-xs opacity-60">{timeAgo(a.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });

  // ── Operator actions ──────────────────────────────────────────────────
  station.action("mission:draft", ({ ctx, data, invalidate }) => {
    const body = String((data as any)?.body ?? "");
    setDraft(db, body);
    flash(ctx, invalidate, "success", "Mission saved.");
    invalidate("mission-panel");
  });

  station.action("swarm:run", ({ ctx, invalidate }) => {
    try {
      const { mission } = armRun(db, { by: "operator" });
      notify({ kind: "control" });
      notify({ kind: "mission" });
      notify({ kind: "wal" });
      flash(ctx, invalidate, "success", `Armed mission #${mission.id}. Agents will pick up work.`);
    } catch (err) {
      flash(ctx, invalidate, "error", err instanceof Error ? err.message : String(err));
    }
  });

  station.action("swarm:pause", ({ ctx, invalidate }) => {
    setPaused(db, true, "operator");
    markAllAgents(db, "paused");
    appendWal(db, { agent: "control-plane", event: "system", summary: "swarm_paused" });
    notify({ kind: "control" });
    notify({ kind: "agents" });
    notify({ kind: "wal" });
    flash(ctx, invalidate, "success", "Swarm paused. In-flight runs finish; no new work starts.");
  });

  station.action("swarm:resume", ({ ctx, invalidate }) => {
    setPaused(db, false, "operator");
    appendWal(db, { agent: "control-plane", event: "system", summary: "swarm_resumed" });
    notify({ kind: "control" });
    notify({ kind: "wal" });
    flash(ctx, invalidate, "success", "Swarm resumed.");
  });
}
