import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import {
  acquireLock,
  appendStdout,
  appendWal,
  armRun,
  getActiveMission,
  getControl,
  getDraft,
  getDraftMission,
  heartbeatLock,
  listAgents,
  listWal,
  pruneOldStdout,
  releaseLock,
  setDraft,
  setMission,
  setPaused,
  tailStdout,
  upsertAgent,
} from "./queries.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

describe("control + missions", () => {
  test("starts idle with no active mission", () => {
    const db = freshDb();
    const control = getControl(db);
    expect(control.state).toBe("idle");
    expect(control.paused).toBe(false);
    expect(control.activeMissionId).toBeNull();
    expect(getActiveMission(db)).toBeNull();
  });

  test("empty mission blocks reads until armed (empty-WAL rule)", () => {
    const db = freshDb();
    // A saved draft is NOT active until Run.
    setMission(db, "Improve the coffee-shop UX");
    expect(getDraftMission(db)?.body).toBe("Improve the coffee-shop UX");
    expect(getActiveMission(db)).toBeNull();

    const { mission, control } = armRun(db);
    expect(control.state).toBe("running");
    expect(control.activeMissionId).toBe(mission.id);
    expect(getActiveMission(db)?.body).toBe("Improve the coffee-shop UX");
  });

  test("armRun with body inserts a new mission and appends swarm_armed", () => {
    const db = freshDb();
    const { mission } = armRun(db, { body: "Fix multiplayer bugs", by: "cody" });
    expect(mission.body).toBe("Fix multiplayer bugs");
    const wal = listWal(db, { order: "desc", limit: 1 });
    expect(wal[0]?.summary).toBe("swarm_armed");
    expect(wal[0]?.agent).toBe("control-plane");
  });

  test("armRun without a mission throws", () => {
    const db = freshDb();
    expect(() => armRun(db)).toThrow(/no mission/i);
  });

  test("pause leaves state unchanged; active mission still resolves when running", () => {
    const db = freshDb();
    armRun(db, { body: "Mission A" });
    setPaused(db, true);
    const control = getControl(db);
    expect(control.paused).toBe(true);
    expect(control.state).toBe("running");
    // Pause does NOT clear the active mission (in-flight finishes).
    expect(getActiveMission(db)?.body).toBe("Mission A");
  });

  test("draft staging is separate from history; armRun(no body) uses the draft", () => {
    const db = freshDb();
    setDraft(db, "Staged work");
    expect(getDraft(db)).toBe("Staged work");
    // Saving a draft does NOT arm and creates no missions row.
    expect(getActiveMission(db)).toBeNull();
    expect(getDraftMission(db)).toBeNull();
    const { mission } = armRun(db);
    expect(mission.body).toBe("Staged work");
    expect(getActiveMission(db)?.body).toBe("Staged work");
    // Clearing the draft.
    setDraft(db, "");
    expect(getDraft(db)).toBeNull();
  });

  test("each Run keeps mission history (versioning)", () => {
    const db = freshDb();
    const a = armRun(db, { body: "v1" }).mission;
    const b = armRun(db, { body: "v2" }).mission;
    expect(b.id).toBeGreaterThan(a.id);
    expect(getActiveMission(db)?.body).toBe("v2");
  });
});

describe("wal append/list/filter", () => {
  test("append assigns id + ts and lists chronologically", () => {
    const db = freshDb();
    const e1 = appendWal(db, { agent: "eng_0", event: "working", summary: "start" });
    const e2 = appendWal(db, { agent: "eng_1", event: "working", summary: "start" });
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(e1.ts).toBeTruthy();

    const asc = listWal(db, { order: "asc" });
    expect(asc.map((e) => e.agent)).toEqual(["eng_0", "eng_1"]);
    const desc = listWal(db, { order: "desc" });
    expect(desc[0]?.agent).toBe("eng_1");
  });

  test("filter by agent", () => {
    const db = freshDb();
    appendWal(db, { agent: "eng_0", event: "working", summary: "a" });
    appendWal(db, { agent: "eng_1", event: "working", summary: "b" });
    appendWal(db, { agent: "eng_0", event: "done", summary: "c", report: "did a thing" });
    const only0 = listWal(db, { agent: "eng_0" });
    expect(only0).toHaveLength(2);
    expect(only0.every((e) => e.agent === "eng_0")).toBe(true);
    expect(only0.find((e) => e.event === "done")?.report).toBe("did a thing");
  });

  test("sinceId returns only newer entries", () => {
    const db = freshDb();
    const first = appendWal(db, { agent: "eng_0", event: "working", summary: "a" });
    appendWal(db, { agent: "eng_0", event: "done", summary: "b" });
    const newer = listWal(db, { sinceId: first.id });
    expect(newer).toHaveLength(1);
    expect(newer[0]?.summary).toBe("b");
  });

  test("extra is round-tripped as json", () => {
    const db = freshDb();
    const e = appendWal(db, {
      agent: "eng_0",
      event: "done",
      summary: "pr",
      extra: { pr: 42, url: "https://x/pr/42" },
    });
    expect(e.jsonExtra).toEqual({ pr: 42, url: "https://x/pr/42" });
    const back = listWal(db, { limit: 1, order: "desc" })[0];
    expect(back?.jsonExtra).toEqual({ pr: 42, url: "https://x/pr/42" });
  });
});

describe("agents", () => {
  test("upsert creates then merges, preserving unspecified fields", () => {
    const db = freshDb();
    upsertAgent(db, { id: "eng_3", status: "working", summary: "loop start", replicaIndex: 3 });
    let row = listAgents(db)[0];
    expect(row?.status).toBe("working");
    expect(row?.replicaIndex).toBe(3);

    // Heartbeat with only status should keep the previous summary + index.
    upsertAgent(db, { id: "eng_3", status: "idle" });
    row = listAgents(db)[0];
    expect(row?.status).toBe("idle");
    expect(row?.currentSummary).toBe("loop start");
    expect(row?.replicaIndex).toBe(3);
  });

  test("listAgents orders by replica index", () => {
    const db = freshDb();
    upsertAgent(db, { id: "eng_2", replicaIndex: 2 });
    upsertAgent(db, { id: "eng_0", replicaIndex: 0 });
    upsertAgent(db, { id: "eng_1", replicaIndex: 1 });
    expect(listAgents(db).map((a) => a.id)).toEqual(["eng_0", "eng_1", "eng_2"]);
  });
});

describe("stdout streaming + cap", () => {
  test("append + tail returns lines in order", () => {
    const db = freshDb();
    appendStdout(db, "eng_0", ["line 1", "line 2"]);
    appendStdout(db, "eng_0", "line 3");
    const tail = tailStdout(db, "eng_0", 10);
    expect(tail.map((c) => c.line)).toEqual(["line 1", "line 2", "line 3"]);
  });

  test("per-agent byte cap prunes oldest lines", () => {
    const db = freshDb();
    // Cap at 50 bytes; each line is 10 bytes ("xxxxxxxxxx").
    for (let i = 0; i < 20; i++) appendStdout(db, "eng_0", "x".repeat(10), 50);
    const tail = tailStdout(db, "eng_0", 100);
    const bytes = tail.reduce((n, c) => n + c.line.length, 0);
    expect(bytes).toBeLessThanOrEqual(50);
    expect(tail.length).toBeGreaterThan(0);
  });

  test("cap is per-agent (one noisy agent does not evict another)", () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) appendStdout(db, "eng_0", "x".repeat(10), 50);
    appendStdout(db, "eng_1", "important", 50);
    expect(tailStdout(db, "eng_1", 10).map((c) => c.line)).toEqual(["important"]);
  });

  test("time-based retention prunes old rows", () => {
    const db = freshDb();
    appendStdout(db, "eng_0", "old line");
    // Backdate the row beyond the retention window.
    db.query("UPDATE stdout_chunks SET ts = ? WHERE agent = ?").run(
      new Date(Date.now() - 10 * 86_400_000).toISOString(),
      "eng_0",
    );
    appendStdout(db, "eng_0", "fresh line");
    const dropped = pruneOldStdout(db, 3 * 86_400_000); // keep 3 days
    expect(dropped).toBe(1);
    expect(tailStdout(db, "eng_0", 10).map((c) => c.line)).toEqual(["fresh line"]);
  });
});

describe("locks", () => {
  test("acquire is exclusive across holders, idempotent for same holder", () => {
    const db = freshDb();
    expect(acquireLock(db, { path: "src/a.ts", holder: "eng_0" }).ok).toBe(true);
    expect(acquireLock(db, { path: "src/a.ts", holder: "eng_0" }).ok).toBe(true); // re-acquire own
    const blocked = acquireLock(db, { path: "src/a.ts", holder: "eng_1" });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("held");
  });

  test("release only by owner; heartbeat extends ttl", () => {
    const db = freshDb();
    acquireLock(db, { path: "src/a.ts", holder: "eng_0", ttlMs: 1000 });
    expect(releaseLock(db, { path: "src/a.ts", holder: "eng_1" }).ok).toBe(false);
    expect(heartbeatLock(db, { path: "src/a.ts", holder: "eng_0", ttlMs: 5000 }).ok).toBe(true);
    expect(releaseLock(db, { path: "src/a.ts", holder: "eng_0" }).released).toBe(true);
    // Released → free to acquire by anyone.
    expect(acquireLock(db, { path: "src/a.ts", holder: "eng_1" }).ok).toBe(true);
  });

  test("expired lock is reclaimable", () => {
    const db = freshDb();
    acquireLock(db, { path: "src/a.ts", holder: "eng_0", ttlMs: 1 });
    // Force expiry.
    db.query("UPDATE locks SET expires_at = ? WHERE path = ?").run(Date.now() - 1000, "src/a.ts");
    expect(acquireLock(db, { path: "src/a.ts", holder: "eng_1" }).ok).toBe(true);
  });
});
