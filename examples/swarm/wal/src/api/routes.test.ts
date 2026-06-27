import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate.ts";
import { createApiApp, type ChangeEvent } from "./routes.ts";

function setup(opts: { operatorToken?: string; ratePerWindow?: number } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  const events: ChangeEvent[] = [];
  const app = createApiApp(db, {
    notify: (e) => events.push(e),
    operatorToken: opts.operatorToken,
    ratePerWindow: opts.ratePerWindow,
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.fetch(
      new Request(`http://t${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, json: json as any };
  };
  return { db, app, events, call };
}

describe("health + default idle state", () => {
  test("GET /healthz", async () => {
    const { call } = setup();
    const { status, json } = await call("GET", "/healthz");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  test("default state is idle with no active mission", async () => {
    const { call } = setup();
    const ctrl = await call("GET", "/control");
    expect(ctrl.json.state).toBe("idle");
    expect(ctrl.json.paused).toBe(false);
    const active = await call("GET", "/mission/active");
    expect(active.json.mission).toBeNull();
    const draft = await call("GET", "/mission");
    expect(draft.json.draft).toBeNull();
  });
});

describe("mission + run arming", () => {
  test("POST /run then GET /wal shows swarm_armed", async () => {
    const { call } = setup();
    const run = await call("POST", "/run", { body: "Fix one UX papercut" });
    expect(run.status).toBe(200);
    expect(run.json.mission.body).toBe("Fix one UX papercut");

    const ctrl = await call("GET", "/control");
    expect(ctrl.json.state).toBe("running");
    expect(ctrl.json.activeMission.body).toBe("Fix one UX papercut");

    const wal = await call("GET", "/wal?order=desc&limit=1");
    expect(wal.json.entries[0].summary).toBe("swarm_armed");
  });

  test("POST /mission saves a draft without arming", async () => {
    const { call } = setup();
    const m = await call("POST", "/mission", { body: "Draft only" });
    expect(m.status).toBe(201);
    expect(m.json.draft).toBe("Draft only");
    const ctrl = await call("GET", "/control");
    expect(ctrl.json.state).toBe("idle"); // draft does not arm
    const active = await call("GET", "/mission/active");
    expect(active.json.mission).toBeNull();
    const draft = await call("GET", "/mission");
    expect(draft.json.draft).toBe("Draft only");
    // Run with no body uses the saved draft.
    await call("POST", "/run");
    const active2 = await call("GET", "/mission/active");
    expect(active2.json.mission.body).toBe("Draft only");
  });

  test("POST /run with no mission errors", async () => {
    const { call } = setup();
    const run = await call("POST", "/run");
    expect(run.status).toBe(400);
  });
});

describe("pause blocks new working from workers", () => {
  test("paused: worker working append → 423, done/boot still allowed", async () => {
    const { call } = setup();
    await call("POST", "/run", { body: "Mission" });
    await call("POST", "/control/pause");

    const ctrl = await call("GET", "/control");
    expect(ctrl.json.paused).toBe(true);

    const working = await call("POST", "/wal/append", {
      agent: "eng_0",
      event: "working",
      summary: "trying to start",
    });
    expect(working.status).toBe(423);

    const done = await call("POST", "/wal/append", {
      agent: "eng_0",
      event: "done",
      summary: "finishing in-flight",
      report: "wrapped up",
    });
    expect(done.status).toBe(201);

    // Resume re-opens working.
    await call("POST", "/control/resume");
    const working2 = await call("POST", "/wal/append", {
      agent: "eng_0",
      event: "working",
      summary: "back to work",
    });
    expect(working2.status).toBe(201);
  });
});

describe("agents grid + heartbeat + stdout", () => {
  test("heartbeat upserts agent row and broadcasts agents", async () => {
    const { call, events } = setup();
    const hb = await call("POST", "/agents/heartbeat", {
      agent: "eng_2",
      status: "working",
      summary: "loop: create-pr",
      replicaIndex: 2,
    });
    expect(hb.status).toBe(200);
    const list = await call("GET", "/agents");
    expect(list.json.agents[0].id).toBe("eng_2");
    expect(list.json.agents[0].status).toBe("working");
    expect(events.some((e) => e.kind === "agents")).toBe(true);
  });

  test("wal working append updates the agent's live status", async () => {
    const { call } = setup();
    await call("POST", "/run", { body: "Mission" });
    await call("POST", "/wal/append", { agent: "eng_5", event: "working", summary: "doing x" });
    const list = await call("GET", "/agents");
    const eng5 = list.json.agents.find((a: any) => a.id === "eng_5");
    expect(eng5.status).toBe("working");
    expect(eng5.currentSummary).toBe("doing x");
  });

  test("stdout append + tail + broadcast", async () => {
    const { call, events } = setup();
    await call("POST", "/agents/eng_0/stdout", { lines: ["line a", "line b"] });
    await call("POST", "/agents/eng_0/stdout", { line: "line c" });
    const tail = await call("GET", "/agents/eng_0/stdout?tail=10");
    expect(tail.json.lines.map((l: any) => l.line)).toEqual(["line a", "line b", "line c"]);
    expect(events.some((e) => e.kind === "stdout" && (e as any).agent === "eng_0")).toBe(true);
  });
});

describe("locks over http", () => {
  test("acquire/conflict/release", async () => {
    const { call } = setup();
    const a = await call("POST", "/locks/acquire", { path: "src/x.ts", holder: "eng_0" });
    expect(a.status).toBe(200);
    const b = await call("POST", "/locks/acquire", { path: "src/x.ts", holder: "eng_1" });
    expect(b.status).toBe(409);
    const r = await call("POST", "/locks/release", { path: "src/x.ts", holder: "eng_0" });
    expect(r.status).toBe(200);
    const c = await call("POST", "/locks/acquire", { path: "src/x.ts", holder: "eng_1" });
    expect(c.status).toBe(200);
  });
});

describe("rate limiting", () => {
  test("per-agent /wal/append limit returns 429; other agents unaffected", async () => {
    const { call } = setup({ ratePerWindow: 3 });
    const post = (agent: string) =>
      call("POST", "/wal/append", { agent, event: "stdout", summary: "x" });
    expect((await post("eng_0")).status).toBe(201);
    expect((await post("eng_0")).status).toBe(201);
    expect((await post("eng_0")).status).toBe(201);
    expect((await post("eng_0")).status).toBe(429); // 4th over the limit
    // A different agent has its own bucket.
    expect((await post("eng_1")).status).toBe(201);
  });
});

describe("operator token auth", () => {
  test("mutating operator routes require the token; agent routes do not", async () => {
    const { call } = setup({ operatorToken: "s3cret" });
    // No token → 401 on /run.
    const noTok = await call("POST", "/run", { body: "x" });
    expect(noTok.status).toBe(401);
    // With token → ok.
    const withTok = await call("POST", "/run", { body: "x" }, { "x-operator-token": "s3cret" });
    expect(withTok.status).toBe(200);
    // Agent ingest is NOT gated.
    const hb = await call("POST", "/agents/heartbeat", { agent: "eng_0", status: "idle" });
    expect(hb.status).toBe(200);
  });
});
