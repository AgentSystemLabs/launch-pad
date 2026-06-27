/**
 * End-to-end smoke: boot the REAL server (bun src/index.ts) as a subprocess and
 * drive it over HTTP + WebSocket — the control plane, a simulated agent, and a
 * live UI morph — mirroring the dashboard's fake-driver pattern without a browser.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8771;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `swarm-e2e-${process.pid}.db`);
let proc: ReturnType<typeof Bun.spawn>;

async function waitReady(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(150);
  }
  throw new Error("server did not become ready");
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(PORT), SWARM_DB: DB, WAL_HOST: "127.0.0.1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitReady();
});

afterAll(() => {
  try {
    proc?.kill();
  } catch {
    /* gone */
  }
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      require("node:fs").rmSync(DB + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("default state is idle; arming a mission flips to running + writes swarm_armed", async () => {
  expect((await (await fetch(`${BASE}/control`)).json()).state).toBe("idle");
  const run = await (
    await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "e2e mission" }),
    })
  ).json();
  expect(run.control.state).toBe("running");
  const wal = await (await fetch(`${BASE}/wal?order=desc&limit=1`)).json();
  expect(wal.entries[0].summary).toBe("swarm_armed");
});

test("an agent heartbeat + stdout shows up via the API", async () => {
  await fetch(`${BASE}/agents/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "engineer_0", status: "working", summary: "e2e", replicaIndex: 0 }),
  });
  const agents = await (await fetch(`${BASE}/agents`)).json();
  expect(agents.agents.find((a: any) => a.id === "engineer_0")?.status).toBe("working");

  await fetch(`${BASE}/agents/engineer_0/stdout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: ["e2e-line-1", "e2e-line-2"] }),
  });
  const out = await (await fetch(`${BASE}/agents/engineer_0/stdout?tail=10`)).json();
  expect(out.lines.map((l: any) => l.line)).toEqual(["e2e-line-1", "e2e-line-2"]);
});

test("live UI: subscribing to agents-grid receives a morph when an agent heartbeats", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?path=/`);
  const frames: any[] = [];
  await new Promise<void>((r) => ws.addEventListener("open", () => r()));
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  ws.send(JSON.stringify({ type: "template", payload: "agents-grid" }));
  await Bun.sleep(300);

  await fetch(`${BASE}/agents/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "engineer_77", status: "working", summary: "morph", replicaIndex: 77 }),
  });

  const deadline = Date.now() + 3000;
  let morph = false;
  while (Date.now() < deadline && !morph) {
    morph = frames.some((m) => m.type === "template" && m.key === "agents-grid" && /engineer_77/.test(m.html ?? ""));
    if (!morph) await Bun.sleep(100);
  }
  ws.close();
  expect(morph).toBe(true);
});

test("pause blocks a worker 'working' append (423)", async () => {
  await fetch(`${BASE}/control/pause`, { method: "POST" });
  const res = await fetch(`${BASE}/wal/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "engineer_0", event: "working", summary: "should be blocked" }),
  });
  expect(res.status).toBe(423);
  await fetch(`${BASE}/control/resume`, { method: "POST" });
});
