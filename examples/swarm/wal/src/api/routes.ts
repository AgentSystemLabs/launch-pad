/**
 * HTTP control-plane API (REST). Mounted on the Station Hono app in index.ts,
 * but standalone-testable: `createApiApp(db).fetch(new Request(...))`.
 *
 * Two audiences:
 *   - Operators (browser): /control/*, /mission, /run  → gated by OPERATOR_TOKEN.
 *   - Agents (workers/MCP): /wal/*, /agents/*, /locks/* → open (in-cluster only).
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  acquireLock,
  appendStdout,
  appendWal,
  armRun,
  getActiveMission,
  getControl,
  getDraft,
  heartbeatLock,
  listAgents,
  listLocks,
  listWal,
  markAllAgents,
  releaseLock,
  setDraft,
  setPaused,
  tailStdout,
  upsertAgent,
  type AgentStatus,
} from "../db/queries.ts";

/** A coarse change event the UI layer maps to Station broadcast keys. */
export type ChangeEvent =
  | { kind: "control" }
  | { kind: "mission" }
  | { kind: "wal" }
  | { kind: "agents" }
  | { kind: "stdout"; agent: string };

export type Notify = (event: ChangeEvent) => void;

export interface ApiOptions {
  /** Called after every mutation so the UI can push a live refresh. */
  notify?: Notify;
  /** Shared operator token; when set, gates mutating operator routes. */
  operatorToken?: string;
  /** Events that agents may append even while paused. */
  walAllowedWhilePaused?: Set<string>;
  /** Register routes on this existing Hono app instead of a fresh one. */
  app?: Hono;
  /** Per-agent max writes per `rateWindowMs` on /wal/append + /stdout (0 = off). */
  ratePerWindow?: number;
  rateWindowMs?: number;
}

/** Minimal fixed-window per-key rate limiter (in-memory; per process). */
function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    if (limit <= 0) return true; // disabled
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now >= cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (cur.count >= limit) return false;
    cur.count++;
    return true;
  };
}

/** WAL events workers may still post while the swarm is paused. */
const DEFAULT_PAUSE_ALLOWED = new Set(["boot", "done", "stdout", "system"]);

/** Map a WAL event to the agent's live grid status (undefined = leave as-is). */
function statusForEvent(event: string): AgentStatus | undefined {
  if (event === "working") return "working";
  if (event === "done") return "idle";
  if (event === "boot") return "sleeping";
  return undefined;
}

export function createApiApp(db: Database, opts: ApiOptions = {}): Hono {
  const app = opts.app ?? new Hono();
  const notify: Notify = opts.notify ?? (() => {});
  const operatorToken = opts.operatorToken ?? process.env.OPERATOR_TOKEN ?? "";
  const pauseAllowed = opts.walAllowedWhilePaused ?? DEFAULT_PAUSE_ALLOWED;
  const rateLimit = makeRateLimiter(
    opts.ratePerWindow ?? Number(process.env.WAL_RATE_PER_WINDOW ?? 240),
    opts.rateWindowMs ?? Number(process.env.WAL_RATE_WINDOW_MS ?? 60_000),
  );

  /** Gate operator mutations behind the shared token (open when unset). */
  const requireOperator = async (c: any, next: () => Promise<void>) => {
    if (operatorToken && c.req.header("x-operator-token") !== operatorToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  // ── Health ────────────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({ ok: true, paused: getControl(db).paused }));

  // ── Control ───────────────────────────────────────────────────────────
  app.get("/control", (c) => {
    const control = getControl(db);
    return c.json({ ...control, activeMission: getActiveMission(db) });
  });

  app.post("/control/pause", requireOperator, (c) => {
    const control = setPaused(db, true, "operator");
    markAllAgents(db, "paused");
    appendWal(db, { agent: "control-plane", event: "system", summary: "swarm_paused" });
    notify({ kind: "control" });
    notify({ kind: "agents" });
    notify({ kind: "wal" });
    return c.json(control);
  });

  app.post("/control/resume", requireOperator, (c) => {
    const control = setPaused(db, false, "operator");
    appendWal(db, { agent: "control-plane", event: "system", summary: "swarm_resumed" });
    notify({ kind: "control" });
    notify({ kind: "wal" });
    return c.json(control);
  });

  // Back-compat: POST /control { paused: bool }
  app.post("/control", requireOperator, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "paused_boolean_required" }, 400);
    }
    const control = setPaused(db, body.paused, body.by ?? "operator");
    if (body.paused) markAllAgents(db, "paused");
    appendWal(db, {
      agent: "control-plane",
      event: "system",
      summary: body.paused ? "swarm_paused" : "swarm_resumed",
    });
    notify({ kind: "control" });
    notify({ kind: "agents" });
    notify({ kind: "wal" });
    return c.json(control);
  });

  // ── Missions ──────────────────────────────────────────────────────────
  // Worker reads this each wake-up: null ⇒ sleep (empty-WAL rule).
  app.get("/mission/active", (c) => c.json({ mission: getActiveMission(db) }));
  // Editable draft body (the editor's staging area).
  app.get("/mission", (c) => c.json({ draft: getDraft(db) }));

  app.post("/mission", requireOperator, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "mission_body_required" }, 400);
    }
    const draft = setDraft(db, body.body);
    notify({ kind: "mission" });
    return c.json({ draft }, 201);
  });

  app.post("/run", requireOperator, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const { control, mission } = armRun(db, { body: body.body, by: body.by ?? "operator" });
      notify({ kind: "control" });
      notify({ kind: "mission" });
      notify({ kind: "wal" });
      return c.json({ control, mission });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── WAL ───────────────────────────────────────────────────────────────
  app.get("/wal", (c) => {
    const agent = c.req.query("agent") || undefined;
    const since = c.req.query("since") || undefined;
    const sinceId = c.req.query("sinceId") ? Number(c.req.query("sinceId")) : undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 500;
    const order = c.req.query("order") === "desc" ? "desc" : "asc";
    const entries = listWal(db, { agent, since, sinceId, limit, order });
    const control = getControl(db);
    return c.json({
      entries,
      agents: listAgents(db).map((a) => a.id),
      paused: control.paused,
      state: control.state,
    });
  });

  app.post("/wal/append", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.agent || !body.event) {
      return c.json({ error: "agent_and_event_required" }, 400);
    }
    if (!rateLimit(`wal:${body.agent}`)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const control = getControl(db);
    if (control.paused && body.agent !== "control-plane" && !pauseAllowed.has(body.event)) {
      return c.json({ error: "swarm_paused", control }, 423);
    }
    const entry = appendWal(db, {
      agent: body.agent,
      event: body.event,
      summary: body.summary ?? "",
      report: body.report,
      loop: body.loop,
      extra: body.extra,
    });
    const status = statusForEvent(body.event);
    if (body.agent !== "control-plane") {
      upsertAgent(db, {
        id: body.agent,
        status,
        summary: body.summary,
        loop: body.loop,
      });
      notify({ kind: "agents" });
    }
    notify({ kind: "wal" });
    return c.json({ entry }, 201);
  });

  // ── Agents ────────────────────────────────────────────────────────────
  app.get("/agents", (c) => c.json({ agents: listAgents(db) }));

  app.post("/agents/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.agent) return c.json({ error: "agent_required" }, 400);
    const agent = upsertAgent(db, {
      id: body.agent,
      status: body.status,
      summary: body.summary,
      loop: body.loop,
      replicaIndex: body.replicaIndex ?? body.replica_index,
    });
    notify({ kind: "agents" });
    return c.json({ agent });
  });

  app.post("/agents/:id/stdout", async (c) => {
    const id = c.req.param("id");
    if (!rateLimit(`stdout:${id}`)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const lines: string[] = Array.isArray(body.lines)
      ? body.lines
      : typeof body.line === "string"
        ? [body.line]
        : [];
    if (lines.length === 0) return c.json({ error: "line_or_lines_required" }, 400);
    const n = appendStdout(db, id, lines);
    // Touch last_seen so a streaming agent stays "live" in the grid.
    upsertAgent(db, { id });
    notify({ kind: "stdout", agent: id });
    return c.json({ appended: n }, 201);
  });

  app.get("/agents/:id/stdout", (c) => {
    const id = c.req.param("id");
    const tail = c.req.query("tail") ? Number(c.req.query("tail")) : 200;
    return c.json({ agent: id, lines: tailStdout(db, id, tail) });
  });

  // ── Locks ─────────────────────────────────────────────────────────────
  app.get("/locks", (c) => c.json({ locks: listLocks(db) }));

  app.post("/locks/acquire", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.path || !body.holder) return c.json({ error: "path_and_holder_required" }, 400);
    const result = acquireLock(db, { path: body.path, holder: body.holder, ttlMs: body.ttlMs });
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/locks/release", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.path || !body.holder) return c.json({ error: "path_and_holder_required" }, 400);
    const result = releaseLock(db, { path: body.path, holder: body.holder });
    return c.json(result, result.ok ? 200 : 403);
  });

  app.post("/locks/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.path || !body.holder) return c.json({ error: "path_and_holder_required" }, 400);
    const result = heartbeatLock(db, { path: body.path, holder: body.holder, ttlMs: body.ttlMs });
    return c.json(result, result.ok ? 200 : 403);
  });

  return app;
}
