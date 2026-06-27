/**
 * Typed data-access helpers over the swarm SQLite schema (see migrate.ts).
 *
 * Every helper takes the `Database` so tests can pass an in-memory db. SELECTs
 * alias snake_case columns to camelCase so the rest of the app (routes, UI
 * templates) sees a clean JS shape.
 */
import type { Database } from "bun:sqlite";

// ── Row shapes ────────────────────────────────────────────────────────────

export type ControlState = "idle" | "running";
export type AgentStatus = "sleeping" | "working" | "idle" | "paused";
export type WalEvent = "boot" | "working" | "done" | "stdout" | "system" | string;

export interface ControlRow {
  paused: boolean;
  state: ControlState;
  activeMissionId: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface MissionRow {
  id: number;
  body: string;
  createdAt: string;
  createdBy: string | null;
}

export interface WalEntry {
  id: number;
  ts: string;
  agent: string;
  event: WalEvent;
  summary: string;
  report: string | null;
  loop: string | null;
  jsonExtra: Record<string, unknown> | null;
}

export interface AgentRow {
  id: string;
  lastSeen: string;
  status: AgentStatus;
  currentSummary: string | null;
  currentLoop: string | null;
  replicaIndex: number | null;
}

export interface StdoutChunk {
  id: number;
  agent: string;
  ts: string;
  line: string;
}

export interface LockRow {
  path: string;
  holder: string;
  expiresAt: number;
}

/** Default per-agent stdout retention (~256KB), overridable via env. */
export const STDOUT_AGENT_CAP_BYTES = Number(process.env.STDOUT_AGENT_CAP_BYTES ?? 262144);
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

const now = () => new Date().toISOString();

// ── Control ───────────────────────────────────────────────────────────────

export function getControl(db: Database): ControlRow {
  const row = db
    .query(
      `SELECT paused, state, active_mission_id AS activeMissionId,
              updated_at AS updatedAt, updated_by AS updatedBy
       FROM control WHERE id = 1`,
    )
    .get() as
    | {
        paused: number;
        state: ControlState;
        activeMissionId: number | null;
        updatedAt: string;
        updatedBy: string | null;
      }
    | undefined;
  if (!row) throw new Error("control row missing — run migrate()");
  return { ...row, paused: Boolean(row.paused) };
}

/** Pause/unpause without touching `state` (operator Pause). */
export function setPaused(db: Database, paused: boolean, by = "operator"): ControlRow {
  db.query(`UPDATE control SET paused = ?, updated_at = ?, updated_by = ? WHERE id = 1`).run(
    paused ? 1 : 0,
    now(),
    by,
  );
  return getControl(db);
}

// ── Missions ────────────────────────────────────────────────────────────────

/** Insert a new immutable mission row (a "Set mission" draft or a Run body). */
export function setMission(db: Database, body: string, by = "operator"): MissionRow {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("mission body required");
  const ts = now();
  const { lastInsertRowid } = db
    .query(`INSERT INTO missions (body, created_at, created_by) VALUES (?, ?, ?)`)
    .run(trimmed, ts, by);
  return getMission(db, Number(lastInsertRowid))!;
}

export function getMission(db: Database, id: number): MissionRow | null {
  return (
    (db
      .query(
        `SELECT id, body, created_at AS createdAt, created_by AS createdBy
         FROM missions WHERE id = ?`,
      )
      .get(id) as MissionRow | undefined) ?? null
  );
}

/**
 * The editable draft body (operator's "Set mission" staging area) — stored in
 * `meta`, separate from the immutable `missions` history, so editing/autosave
 * doesn't spawn history rows. Empty string clears it.
 */
export function setDraft(db: Database, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    db.query(`DELETE FROM meta WHERE key = 'draft_mission'`).run();
    return "";
  }
  db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('draft_mission', ?)`).run(trimmed);
  return trimmed;
}

export function getDraft(db: Database): string | null {
  const row = db.query(`SELECT value FROM meta WHERE key = 'draft_mission'`).get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/** Latest mission row (a previously armed mission), regardless of armed state. */
export function getDraftMission(db: Database): MissionRow | null {
  return (
    (db
      .query(
        `SELECT id, body, created_at AS createdAt, created_by AS createdBy
         FROM missions ORDER BY id DESC LIMIT 1`,
      )
      .get() as MissionRow | undefined) ?? null
  );
}

/**
 * The mission agents must read. Empty-WAL rule: returns null unless
 * state === 'running' AND control.active_mission_id points at a real row.
 */
export function getActiveMission(db: Database): MissionRow | null {
  const control = getControl(db);
  if (control.state !== "running" || control.activeMissionId == null) return null;
  return getMission(db, control.activeMissionId);
}

/**
 * Arm the swarm: optionally save a fresh mission body, point control at it,
 * set state=running + paused=false, and append the `swarm_armed` system WAL —
 * all in one transaction.
 */
export function armRun(
  db: Database,
  opts: { body?: string; by?: string } = {},
): { control: ControlRow; mission: MissionRow } {
  const by = opts.by ?? "operator";
  const run = db.transaction(() => {
    let mission: MissionRow | null;
    if (opts.body && opts.body.trim()) {
      mission = setMission(db, opts.body, by);
    } else {
      // Prefer the editable draft; fall back to the last armed mission.
      const draft = getDraft(db);
      mission = draft ? setMission(db, draft, by) : getDraftMission(db);
      if (!mission) throw new Error("no mission to run — set a mission first");
    }
    db.query(
      `UPDATE control SET paused = 0, state = 'running', active_mission_id = ?,
              updated_at = ?, updated_by = ? WHERE id = 1`,
    ).run(mission.id, now(), by);
    appendWal(db, {
      agent: "control-plane",
      event: "system",
      summary: "swarm_armed",
      report: `Operator armed mission #${mission.id}.`,
    });
    return mission;
  });
  const mission = run();
  return { control: getControl(db), mission };
}

// ── WAL ─────────────────────────────────────────────────────────────────────

export function appendWal(
  db: Database,
  entry: {
    agent: string;
    event: WalEvent;
    summary: string;
    report?: string | null;
    loop?: string | null;
    extra?: Record<string, unknown> | null;
  },
): WalEntry {
  if (!entry.agent) throw new Error("wal entry requires agent");
  if (!entry.event) throw new Error("wal entry requires event");
  const ts = now();
  const { lastInsertRowid } = db
    .query(
      `INSERT INTO wal_entries (ts, agent, event, summary, report, loop, json_extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      entry.agent,
      entry.event,
      entry.summary ?? "",
      entry.report ?? null,
      entry.loop ?? null,
      entry.extra ? JSON.stringify(entry.extra) : null,
    );
  return getWalEntry(db, Number(lastInsertRowid))!;
}

function getWalEntry(db: Database, id: number): WalEntry | null {
  const row = db
    .query(
      `SELECT id, ts, agent, event, summary, report, loop, json_extra AS jsonExtra
       FROM wal_entries WHERE id = ?`,
    )
    .get(id) as (Omit<WalEntry, "jsonExtra"> & { jsonExtra: string | null }) | undefined;
  if (!row) return null;
  return { ...row, jsonExtra: row.jsonExtra ? JSON.parse(row.jsonExtra) : null };
}

export function listWal(
  db: Database,
  opts: {
    agent?: string;
    since?: string;
    sinceId?: number;
    limit?: number;
    order?: "asc" | "desc";
  } = {},
): WalEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 10_000);
  const order = opts.order === "desc" ? "desc" : "asc";
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.agent) {
    where.push("agent = ?");
    args.push(opts.agent);
  }
  if (opts.sinceId != null) {
    where.push("id > ?");
    args.push(opts.sinceId);
  } else if (opts.since) {
    where.push("ts > ?");
    args.push(opts.since);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Always take the most-recent `limit` rows, then present in requested order.
  const rows = db
    .query(
      `SELECT id, ts, agent, event, summary, report, loop, json_extra AS jsonExtra
       FROM wal_entries ${whereSql}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, limit) as (Omit<WalEntry, "jsonExtra"> & { jsonExtra: string | null })[];
  const mapped = rows.map((r) => ({
    ...r,
    jsonExtra: r.jsonExtra ? JSON.parse(r.jsonExtra) : null,
  }));
  return order === "asc" ? mapped.reverse() : mapped;
}

// ── Agents ────────────────────────────────────────────────────────────────

export function upsertAgent(
  db: Database,
  agent: {
    id: string;
    status?: AgentStatus;
    summary?: string | null;
    loop?: string | null;
    replicaIndex?: number | null;
  },
): AgentRow {
  if (!agent.id) throw new Error("agent id required");
  db.query(
    `INSERT INTO agents (id, last_seen, status, current_summary, current_loop, replica_index)
     VALUES (@id, @lastSeen, COALESCE(@status, 'sleeping'), @summary, @loop, @replicaIndex)
     ON CONFLICT(id) DO UPDATE SET
       last_seen = @lastSeen,
       status = COALESCE(@status, agents.status),
       current_summary = COALESCE(@summary, agents.current_summary),
       current_loop = COALESCE(@loop, agents.current_loop),
       replica_index = COALESCE(@replicaIndex, agents.replica_index)`,
  ).run({
    "@id": agent.id,
    "@lastSeen": now(),
    "@status": agent.status ?? null,
    "@summary": agent.summary ?? null,
    "@loop": agent.loop ?? null,
    "@replicaIndex": agent.replicaIndex ?? null,
  });
  return getAgent(db, agent.id)!;
}

export function getAgent(db: Database, id: string): AgentRow | null {
  return (
    (db
      .query(
        `SELECT id, last_seen AS lastSeen, status,
                current_summary AS currentSummary, current_loop AS currentLoop,
                replica_index AS replicaIndex
         FROM agents WHERE id = ?`,
      )
      .get(id) as AgentRow | undefined) ?? null
  );
}

export function listAgents(db: Database): AgentRow[] {
  return db
    .query(
      `SELECT id, last_seen AS lastSeen, status,
              current_summary AS currentSummary, current_loop AS currentLoop,
              replica_index AS replicaIndex
       FROM agents
       ORDER BY COALESCE(replica_index, 1e9), id`,
    )
    .all() as AgentRow[];
}

/** Mark every known agent as paused (used by operator Pause for UI accuracy). */
export function markAllAgents(db: Database, status: AgentStatus): void {
  db.query(`UPDATE agents SET status = ? WHERE 1`).run(status);
}

// ── Stdout ──────────────────────────────────────────────────────────────────

/**
 * Append one or more stdout lines for an agent, then prune the oldest rows so
 * total retained bytes for that agent stay under `capBytes`.
 */
export function appendStdout(
  db: Database,
  agent: string,
  lines: string | string[],
  capBytes = STDOUT_AGENT_CAP_BYTES,
): number {
  if (!agent) throw new Error("agent required");
  const list = (Array.isArray(lines) ? lines : [lines]).filter((l) => l != null);
  if (list.length === 0) return 0;
  const ts = now();
  const insert = db.query(`INSERT INTO stdout_chunks (agent, ts, line) VALUES (?, ?, ?)`);
  const tx = db.transaction((rows: string[]) => {
    for (const line of rows) insert.run(agent, ts, String(line));
  });
  tx(list);
  pruneStdout(db, agent, capBytes);
  return list.length;
}

/** Keep only the newest rows for `agent` whose cumulative bytes fit in capBytes. */
export function pruneStdout(db: Database, agent: string, capBytes = STDOUT_AGENT_CAP_BYTES): number {
  const rows = db
    .query(`SELECT id, LENGTH(line) AS len FROM stdout_chunks WHERE agent = ? ORDER BY id DESC`)
    .all(agent) as { id: number; len: number }[];
  let acc = 0;
  let cutoffId: number | null = null;
  for (const r of rows) {
    acc += r.len;
    if (acc > capBytes) {
      cutoffId = r.id;
      break;
    }
  }
  if (cutoffId == null) return 0;
  const { changes } = db
    .query(`DELETE FROM stdout_chunks WHERE agent = ? AND id <= ?`)
    .run(agent, cutoffId);
  return Number(changes);
}

/** Time-based retention: drop stdout lines older than `maxAgeMs` (all agents). */
export function pruneOldStdout(db: Database, maxAgeMs: number): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const { changes } = db.query(`DELETE FROM stdout_chunks WHERE ts < ?`).run(cutoff);
  return Number(changes);
}

export function tailStdout(db: Database, agent: string, tail = 200): StdoutChunk[] {
  const n = Math.min(Math.max(tail, 1), 5000);
  const rows = db
    .query(`SELECT id, agent, ts, line FROM stdout_chunks WHERE agent = ? ORDER BY id DESC LIMIT ?`)
    .all(agent, n) as StdoutChunk[];
  return rows.reverse();
}

// ── Locks ─────────────────────────────────────────────────────────────────

export function pruneExpiredLocks(db: Database): void {
  db.query(`DELETE FROM locks WHERE expires_at <= ?`).run(Date.now());
}

export function acquireLock(
  db: Database,
  opts: { path: string; holder: string; ttlMs?: number },
): { ok: boolean; reason?: string; lock?: LockRow } {
  pruneExpiredLocks(db);
  const existing = getLock(db, opts.path);
  if (existing && existing.holder !== opts.holder) {
    return { ok: false, reason: "held", lock: existing };
  }
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_LOCK_TTL_MS;
  const expiresAt = Date.now() + ttl;
  db.query(
    `INSERT INTO locks (path, holder, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at`,
  ).run(opts.path, opts.holder, expiresAt);
  return { ok: true, lock: getLock(db, opts.path)! };
}

export function releaseLock(
  db: Database,
  opts: { path: string; holder: string },
): { ok: boolean; reason?: string; released?: boolean } {
  const existing = getLock(db, opts.path);
  if (!existing) return { ok: true, released: false };
  if (existing.holder !== opts.holder) return { ok: false, reason: "not_owner" };
  db.query(`DELETE FROM locks WHERE path = ?`).run(opts.path);
  return { ok: true, released: true };
}

export function heartbeatLock(
  db: Database,
  opts: { path: string; holder: string; ttlMs?: number },
): { ok: boolean; reason?: string; lock?: LockRow } {
  const existing = getLock(db, opts.path);
  if (!existing || existing.holder !== opts.holder) {
    return { ok: false, reason: "not_owner" };
  }
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_LOCK_TTL_MS;
  db.query(`UPDATE locks SET expires_at = ? WHERE path = ?`).run(Date.now() + ttl, opts.path);
  return { ok: true, lock: getLock(db, opts.path)! };
}

export function getLock(db: Database, path: string): LockRow | null {
  return (
    (db
      .query(`SELECT path, holder, expires_at AS expiresAt FROM locks WHERE path = ?`)
      .get(path) as LockRow | undefined) ?? null
  );
}

export function listLocks(db: Database): LockRow[] {
  pruneExpiredLocks(db);
  return db
    .query(`SELECT path, holder, expires_at AS expiresAt FROM locks ORDER BY path`)
    .all() as LockRow[];
}
