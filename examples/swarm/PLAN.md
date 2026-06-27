# Swarm — phased development plan

> **Audience:** implementers (e.g. Opus 4.8) verifying and continuing this example.  
> **Location:** `launch-pad/examples/swarm`  
> **North star:** demonstrate Launch Pad running **N concurrent headless `cursor-agent` engineers** that autonomously improve a real repo ([coffee-shop](https://github.com/YOUR_ORG/coffee-shop)), coordinated through a **central control plane** you operate from one live dashboard.

This document captures everything discussed across design sessions. Check boxes in order within each phase; later phases assume earlier ones are done.

---

## Product goal (what we are proving)

A developer runs `launchpad deploy` from `examples/swarm` and gets:

1. **~100 worker containers** (configurable `replicas`) each running `cursor-agent` headless in a loop.
2. A **single operator URL** (`https://swarm.example.com`) showing a **live dashboard**: every agent, what it is doing, WAL history, and **streaming stdout** as work happens.
3. **Operator-driven missions** — you **set the WAL** (high-level goal / task brief) in the UI and click **Run**; only then do agents pick up work.
4. **Autonomous engineering** — no human code review gate; agents self-review, open small PRs, fix conflicts, merge when checks pass. **Only the operator can pause** the swarm.
5. **Launch Pad owns infra** — ECR images, EC2 app pool, edge HTTPS, secrets via SSM, autoscale optional. No separate control-plane product beyond this example.

**Demo story:** type *"Improve coffeeshop UX and fix multiplayer bugs — small PRs only"*, click Run, watch 100 agents trickle online (boot jitter), see the grid fill with `working` → `done` reports and live log lines, pause anytime.

---

## Architecture (target end state)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  swarm.example.com  —  Bun + @orbital-js/station  (wal service)         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ Mission edit │  │ Run / Pause  │  │ Agent grid   │  │ WAL timeline │ │
│  │ (seed WAL)   │  │ controls     │  │ + stdout     │  │ + filters    │ │
│  └──────┬───────┘  └──────┬───────┘  └──────▲───────┘  └──────▲───────┘ │
│         │                 │                  │                  │         │
│         └────────────┬────┴──────────────────┴──────────────────┘         │
│                      ▼                                                    │
│              bun:sqlite (/data/swarm.db)                                  │
│    tables: control, mission, wal_entries, agents, stdout_chunks, locks    │
│                      ▲                                                    │
│         WebSocket DOM morph (orbital broadcast keys)                      │
└──────────────────────┼────────────────────────────────────────────────────┘
                       │ HTTPS
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
 engineer_0       engineer_1  …   engineer_99
 cursor-agent     cursor-agent      cursor-agent
 MCP (stdio)      MCP               MCP
     │                 │                 │
     └─────────────────┴─────────────────┘
                       │
              git clone + PRs/issues
                       ▼
              coffee-shop (target repo)
```

**Launch Pad services** (`launch-pad.toml`):

| Service | Role |
| ------- | ---- |
| `wal` | Control plane: SQLite, REST/MCP ingest, **orbital-js operator UI**, sticky volume `/data` |
| `engineer` | Worker pool: `cursor-agent` loop, talks to `wal` only (plus GitHub, target git remote) |

**Reference implementations in this monorepo:**

- [`packages/dashboard`](../../packages/dashboard) — orbital-js + Bun pattern (WS morph, no polling)
- [`orbital-js`](../../../orbital-js) — `@orbital-js/station` framework (`../orbital-js` from this dir)
- [`packages/dashboard/scripts/ux-improve-loop.sh`](../../packages/dashboard/scripts/ux-improve-loop.sh) — headless `cursor-agent` invocation

---

## Core contracts (do not drift)

### 1. Operator mission → WAL seed

- The UI lets the operator **author a mission** (markdown or plain text): high-level goal, constraints, links.
- **Run** writes this to durable storage and sets `control.state = "running"`.
- All agents read the **current mission** from the API on each wake-up and inject it into their prompt (replacing static `SWARM_GOAL` env over time).

### 2. Empty WAL = agents sleep

- If the API returns **no active mission / empty WAL** (define precisely: `mission` row absent or `control.state != "running"` — pick one, document in code):
  - Workers **must not** start `cursor-agent`.
  - Workers sleep `IDLE_POLL_SEC` (e.g. 30–60s) and poll again.
- This replaces “always loop forever regardless of operator intent.”

### 3. Pause / Start (operator only)

| Control | `control.paused` | `control.state` | Agent behavior |
| ------- | ---------------- | --------------- | -------------- |
| **Pause** | `true` | unchanged | No new tasks; finish in-flight optional (see decision below) |
| **Start / Resume** | `false` | `running` | Agents may claim work when mission exists |
| **Idle (initial)** | `false` | `idle` | Sleep until operator clicks **Run** |

- Pause is the **only** human gate during normal operation (no PR approval humans).

### 4. WAL event shape (agent → API)

Keep the log **simple**. Each append:

| Field | Required | Purpose |
| ----- | -------- | ------- |
| `agent` | yes | Container id / hostname (`launchpad_swarm_engineer_N`) |
| `event` | yes | `boot` \| `working` \| `done` \| `stdout` \| `system` |
| `summary` | yes | One line for timeline + grid |
| `report` | on `done` | One paragraph: PR merged, issue filed, research, etc. |
| `loop` | optional | Which engineering loop (`create-pr`, `pr-review`, …) |
| `ts` | server | ISO timestamp |

### 5. File locks (unchanged concept)

- Before editing repo paths, agents call `lock_acquire` / `heartbeat` / `release`.
- Store locks in SQLite (not `locks.json`).
- On failure, agent **re-reads WAL** before retrying overlapping scope.

### 6. Boot jitter

- Spread agent starts over **`BOOT_JITTER_MAX_SEC`** (default 300s):
  - `spread = (replica_index × MAX) / 100` + `random(0..29)`.
- Prevents thundering herd when operator clicks Run.

### 7. Engineering loops (`loops/`)

Agents work from **atomic task prompts** aligned with coffee-shop:

| Loop | Purpose |
| ---- | ------- |
| `idea.md` | File small feature issues |
| `bug-report.md` | Reproduce + issue (+ tiny fix PR) |
| `ux-review.md` | Browser/UX pass |
| `security-review.md` | Threat slice |
| `pr-review.md` | Review open PR (no human gate) |
| `create-pr.md` | Implement one issue → PR |
| `fix-conflicts.md` | Rebase/conflict fix |
| `merge-pr.md` | Autonomous merge when green |
| `self-review.md` | Bot self-approval |
| `label-issues.md` | Triage/export |
| `run-and-verify.md` | Run app/scripts, report only |

**Rules:** one focus per session, small PRs, never ask humans questions, MCP + WAL for status.

### 8. Secrets (Launch Pad SSM)

| Secret | Service | Purpose |
| ------ | ------- | ------- |
| `CURSOR_API_KEY` | engineer | headless cursor-agent |
| `GITHUB_TOKEN` | engineer | issues, PRs, merge |
| `GIT_SSH_KEY` | engineer | clone/push target repo |
| `OPENAI_API_KEY` | engineer | optional, target repo tooling |

Never bake keys into images.

### 9. GitHub as artifact store (not operator UI)

- PRs, issues, labels remain on GitHub.
- **Operator UI is the WAL dashboard** — not GitHub tracking issues (legacy `TRACKING_ISSUE` env can be removed once UI is primary).

### 10. Live UI via orbital-js

- Replace static `wal/public/index.html` + 3s polling with **Station templates** and **broadcast key refresh** when:
  - WAL entry inserted
  - agent status changes
  - stdout chunk appended
  - control/mission changes
- Follow `packages/dashboard` patterns: `Bun.serve`, `station.websocket`, `p-*` attributes, `action("…")` for Run/Pause/Set mission.

---

## Current state (already in repo)

Use this as the baseline before Phase 1:

- [x] `launch-pad.toml` — `wal` + `engineer` services, volume, secrets, env
- [x] `worker/` — Dockerfile, entrypoint (git clone, SSH), `run-loop.sh` (cursor-agent loop)
- [x] Boot jitter in entrypoint (`BOOT_JITTER_MAX_SEC`)
- [x] Pause poll in `run-loop.sh` (`GET /control`) — **needs rework for mission/empty WAL**
- [x] `mcp/server.mjs` — stdio MCP: WAL, locks, GitHub
- [x] `loops/*` — engineering task prompts
- [x] `prompt.md` — master agent instructions
- [x] `wal/server.mjs` — **Node http**, `wal.jsonl` + `locks.json` + `control.json`
- [x] `wal/public/index.html` — **static** timeline, agent filter, pause/resume, polling

**Gaps vs target:** no SQLite, no orbital-js, no mission editor + Run, no empty-WAL sleep, no agent grid, no stdout streaming, no live WS updates.

---

## Phase 0 — Decisions & repo layout

Lock these before large refactors:

- [x] **Runtime:** `wal` service becomes **Bun** (required for orbital-js + `bun:sqlite`). `engineer` workers stay Node/bash + cursor-agent.
- [x] **orbital-js link:** `"@orbital-js/station": "file:../../../../orbital-js/packages/station"` (from `examples/swarm/wal`, mirror dashboard pattern); documented in `wal/README.md` + swarm README (`bun install`).
- [x] **Empty WAL rule:** agents work only when `control.state === "running"` **AND** `control.active_mission_id IS NOT NULL`. Surfaced as `GET /mission/active` returning `null` ⇒ sleep. Enforced in `db/queries.ts:getActiveMission` and the worker poll loop.
- [x] **In-flight on pause:** option **(a)** — pause prevents *new* `cursor-agent` runs; an in-flight run finishes. The loop checks pause only at the top of each iteration.
- [x] **Stdout transport:** agents POST chunked lines to `POST /agents/:id/stdout`; retained bytes per agent capped in SQLite (default `STDOUT_AGENT_CAP_BYTES=262144` ≈ 256KB, oldest lines pruned on append).
- [x] **Auth:** single shared `OPERATOR_TOKEN` header (`x-operator-token`) on mutating operator routes (`/run`, `/control/*`, `/mission`). Unset ⇒ open (dev). Agent ingest routes (`/wal/append`, `/agents/*`, `/locks/*`) are not operator-gated. Documented in README.
- [x] **Domain:** single `swarm.example.com` for UI + API (edge routes to `wal`).
- [x] **Mission versioning (open Q1):** each `POST /mission` and each `POST /run {body}` inserts a new immutable `missions` row (history kept); `control.active_mission_id` points at the armed one.

---

## Phase 1 — SQLite data layer

Replace JSONL/JSON files with **`bun:sqlite`** on the sticky volume (`/data/swarm.db`).

### Schema (v1)

- [x] `control` — singleton: `paused`, `state` (`idle` \| `running`), `active_mission_id`, `updated_at`, `updated_by`
- [x] `missions` — `id`, `body` (markdown), `created_at`, `created_by`; `control.active_mission_id` FK
- [x] `wal_entries` — `id`, `ts`, `agent`, `event`, `summary`, `report`, `loop`, `json_extra`
- [x] `agents` — `id` (hostname), `last_seen`, `status` (`sleeping` \| `working` \| `idle` \| `paused`), `current_summary`, `current_loop`, `replica_index`
- [x] `stdout_chunks` — `id`, `agent`, `ts`, `line`; index `(agent, id)` for tail
- [x] `locks` — `path`, `holder`, `expires_at`

### Migration

- [x] Add `wal/src/db/migrate.ts` — idempotent CREATE TABLE on boot (`openDatabase` applies WAL pragma + seeds singleton control row)
- [ ] One-time import from legacy `wal.jsonl` if present (optional — skipped; clean cutover)
- [x] Remove `wal.jsonl` / `locks.json` / `control.json` writes from hot path (replaced by SQLite)

### Data access module

- [x] `wal/src/db/queries.ts` — typed helpers: `appendWal`, `listWal`, `upsertAgent`, `appendStdout`, `getControl`, `setMission`, `armRun`, `setPaused`, `getActiveMission`, `tailStdout`, lock helpers
- [x] WAL list API: `GET /wal?agent=&since=&sinceId=&limit=&order=asc`
- [x] Agents register heartbeat: `POST /agents/heartbeat` `{ agent, status, summary, loop, replicaIndex }`

### Verification

- [x] `bun test src/db` — append/list/filter, mission arm, empty mission blocks reads, stdout cap, locks (18 tests pass)
- [x] Volume survives container replace (verified: file-backed DB reopened → control+mission persisted)

---

## Phase 2 — REST + MCP API (control plane)

Unify HTTP and MCP on the same SQLite layer.

### HTTP routes

- [x] `GET /healthz`
- [x] `GET /control` — `{ paused, state, activeMission }`
- [x] `POST /control/pause` / `POST /control/resume` (plus back-compat `POST /control { paused }`)
- [x] `POST /mission` — operator sets mission body (draft); `GET /mission` (draft), `GET /mission/active` (armed)
- [x] `POST /run` — atomically (transaction): save mission if needed, set `state=running`, `paused=false`, append system WAL `swarm_armed`
- [x] `GET /wal` — chronological entries + agent list for filters
- [x] `POST /wal/append` — agents/MCP (reject if paused except `done`/`boot`/`stdout`/`system`)
- [x] `GET /agents` — dashboard grid source
- [x] `POST /agents/heartbeat`
- [x] `POST /agents/:id/stdout` — append line(s)
- [x] `GET /agents/:id/stdout?tail=200`
- [x] `POST /locks/acquire|release|heartbeat` — SQLite backed (+ `GET /locks`)

### MCP (`mcp/server.mjs`)

- [x] Point MCP at internal HTTP base URL (`WAL_URL`)
- [x] Tools: `wal_append`, `wal_read`, `lock_*`, `agent_status` (heartbeat), `stdout_append`, `github_*`
- [x] `wal_append` enforces `report` on `done`

### Verification

- [x] `curl POST /run` then `GET /wal` shows `swarm_armed` (live HTTP smoke)
- [x] `curl POST /control/pause` → worker `working` append → 423; `done`/`boot` still allowed (unit + live)
- [x] Empty/default state: `GET /control` → `state=idle` → `GET /mission/active` null
- [x] `bun test src/api` — 11 route tests pass; MCP driven over stdio JSON-RPC end-to-end

---

## Phase 3 — orbital-js operator UI

Replace static HTML with Station SSR + live morph.

### Scaffold

- [x] `wal/package.json` — Bun, `@orbital-js/station`, `hono`, `zod`; `file:` link to `../../../../orbital-js/packages/station`
- [x] `wal/src/index.ts` — Station (`station.listen()` = `Bun.serve` + `station.websocket`); REST API mounted on `station.getApp()`
- [x] `wal/Dockerfile` — `oven/bun` base; self-contained `dist/` bundle (see `scripts/bundle.ts` — orbital can't `bun install` in-image since it's a sibling repo outside the build context)
- [x] Tailwind/DaisyUI (`night` theme, matches dashboard)

### Pages / templates

- [x] **Layout** — nav: Dashboard | WAL; live status pill + Pause/Resume in header; connection-status banner
- [x] **Mission panel** — textarea, **Set mission** (draft → `meta`), **Run** (arm + broadcast); shows armed mission
- [x] **Agent grid** — table: agent id (link), status badge, loop, doing, last-seen
- [x] **Agent detail** — current task + live scrolling stdout (`/agents/:id`)
- [x] **WAL timeline** — chronological, filter by agent, event-colored, `report` expanded (`/timeline`)

### Realtime

- [x] On every mutation (`appendWal`, `appendStdout`, `upsertAgent`, control change) → `station.broadcast` keys: `control-bar`, `mission-panel`, `agents-grid`, `wal-feed`, `agent-task`, `agent-stdout` (mapped from a coarse `ChangeEvent` in `index.ts:notify`)
- [x] No client-side polling; `p-*` attributes (`p-href`, `p-template`, `p-action`, `p-click-action`, `p-input-action`, `p-load`)
- [x] stdout broadcast filtered to the viewing connection (`ctx.viewingAgent`)

### Verification

- [x] Open UI, set mission, click Run — mission persists on refresh (WS action + SSR reload verified)
- [x] Simulate WAL append/heartbeat via REST — grid morphs without reload (WS frame asserted)
- [x] Pause — status pill flips to paused (WS broadcast asserted)
- [x] Filtered stdout: viewer of agent A gets morph, viewer of B does not
- [x] Docker image builds (`oven/bun`, linux/amd64), serves `/`, `/static/station.js`, `/styles.css`, persists DB across container restart

---

## Phase 4 — Worker contract (agents obey control plane)

Update `worker/run-loop.sh` + `entrypoint.sh` + `prompt.md`.

### Poll loop (pseudocode)

```
loop forever:
  control = GET /control
  if control.paused → sleep PAUSE_POLL_SEC; continue
  if control.state != "running" OR no active mission → sleep IDLE_POLL_SEC; continue
  mission = GET /mission/active
  if empty → sleep IDLE_POLL_SEC; continue
  pick loop file (replica index rotation)
  POST wal working
  run cursor-agent with mission.body + prompt.md + loop
  on failure → wal done (fallback); on success agent posts done via MCP
  sleep LOOP_IDLE_SEC
```

### Tasks

- [x] Remove hard dependency on `SWARM_GOAL` env — fetch mission from `GET /mission/active` (env fallback only if explicitly set)
- [x] `IDLE_POLL_SEC` env (default 45) distinct from `PAUSE_POLL_SEC` (default 15)
- [x] Heartbeat: `POST /agents/heartbeat` each iteration (status sleeping/working/idle/paused + summary + loop)
- [x] Stream stdout: wrapper pipe `cursor-agent 2>&1 | stream_stdout` → batched `POST /agents/:id/stdout`
- [x] Boot jitter retained; registers in grid immediately (sleeping), then sleeps if no mission (no Cursor spend)
- [x] Update `prompt.md` — mission comes from operator; empty = sleep; documents `agent_status`/`stdout_append`

### Verification

- [x] No Run → agent idle (`status=sleeping`), **no cursor-agent invoked**, zero stdout (verified with 1 worker)
- [x] Click Run → agent posts `working` and streams stdout (verified: `STREAM_MARKER` reached `/agents/:id/stdout`)
- [x] Pause → new work stops (`working` count flat while paused; `status=paused`); Resume continues
- [x] stdout streaming verified against BOTH a fake and the **real** cursor-agent binary; clean exit ⇒ no false "Loop failed"

---

## Phase 5 — Autonomous engineering (coffee-shop)

End-to-end demo on real repo.

### Target repo

- [x] `TARGET_REPO` / `GITHUB_REPO` placeholders in `launch-pad.toml` (operator fills the coffee-shop remote)
- [x] Deploy key / PAT push+merge rights documented (README)
- [x] Branch protection: bot merge without human review documented (README)

### Loop hardening

- [x] Every loop file ends with a required close-out: `agent_status` → `stdout_append` → `wal_append done` + `report` → release locks
- [x] `create-pr` / `merge-pr` / `pr-review` autonomous path documented in README
- [ ] Optional: Playwright in worker image for `ux-review` (noted as an open decision; not added)

### Launch Pad scale

- [x] `launchpad scale engineer replicas 100` + autoscale policy documented (README)
- [x] Capacity math in README (1 vCPU / 2 GB per worker; 100 ⇒ ~100 vCPU / 200 GB)

### Verification

> Deferred by design: a live autonomous coffee-shop PR cycle needs a real target repo + Cursor
> spend and the 100-agent fan-out. The full worker→cursor-agent→WAL path is verified in Phase 4
> with a fake **and** the real `cursor-agent` binary; the small-cluster live deploy (Phase below)
> validates the stack end-to-end with 1–2 workers.

- [~] Operator sets mission *"Fix one UX papercut and open a PR"* (wired; run when a target repo is configured)
- [~] At least one PR opened on coffee-shop from the swarm branch prefix (deferred — needs target repo)
- [~] WAL `done` entries contain paragraph reports with PR URLs (deferred — needs target repo)

---

## Phase 6 — Observability & hardening

- [x] `launchpad logs engineer --follow` documented alongside UI stdout (README)
- [x] SQLite retention — per-agent byte cap on append (`STDOUT_AGENT_CAP_BYTES`) + hourly time-based sweep (`pruneOldStdout`, `STDOUT_RETENTION_DAYS`)
- [x] Rate limit `POST /wal/append` (and `/agents/:id/stdout`) per agent (fixed-window, `WAL_RATE_PER_WINDOW`) — returns 429
- [x] `OPERATOR_TOKEN` on `/run`, `/control/*`, `/mission` (HTTP header + WS `?token=` beforeAction gate)
- [x] E2E smoke: runnable **Bun integration test** (boots real server, HTTP+WS) + **Playwright** browser test (set mission → Run → live agent + stdout → Pause). Both pass.

---

## Launch Pad deploy checklist (operator)

- [ ] Edit `launch-pad.toml` domain + `TARGET_REPO` + `GITHUB_REPO`
- [ ] `launchpad secret set` × 3 (or 4) on `engineer`
- [ ] DNS wildcard → edge EIP; `launchpad dns verify`
- [ ] `launchpad deploy --yes`
- [ ] Open `https://swarm.example.com`, set mission, **Run**
- [ ] `launchpad scale engineer replicas <N>`

---

## File map (target)

```
examples/swarm/
  PLAN.md                 ← this file
  README.md               ← operator quick start (keep in sync)
  launch-pad.toml
  prompt.md
  loops/
  worker/                 ← engineer image only
  mcp/                    ← stdio MCP (may call wal HTTP or sqlite)
  wal/
    Dockerfile            ← Bun
    package.json
    src/
      index.ts            ← Bun.serve + Station
      db/migrate.ts
      db/queries.ts
      routes/…
      pages/…             ← orbital templates
```

---

## Explicit non-goals (v1)

- Multi-tenant auth / RBAC
- Redis / Postgres (SQLite on sticky volume is enough for single `wal` replica)
- Shared vector memory / RAG between agents
- Launch Pad dashboard integration (swarm UI is separate)
- Running cursor-agent on the operator's laptop (everything in cluster workers)

---

## Open questions for product owner

1. **Mission versioning:** on each Run, create a new `missions` row or overwrite draft?
2. **Stdout privacy:** redact env/secrets in streamed lines?
3. **Agent identity:** hostname only, or also expose Launch Pad node id + replica from labels?
4. **Concurrent missions:** one active mission globally, or per-run generations?
5. **coffee-shop path:** confirm canonical GitHub org/repo for docs and `loops/` references.

---

## Success criteria (demo ready)

- [x] Operator sets mission in UI, clicks **Run**, does not touch GitHub for status (Playwright + live HTTPS verified)
- [x] Dashboard shows **all agents** with live status and stdout (grid + agent detail morph live)
- [x] WAL timeline is chronological, filterable, updates over WebSocket without polling
- [x] **Pause** stops new work; **Resume** continues (unit + live)
- [x] With no mission / idle state, agents **sleep** (no Cursor spend) — verified with a worker
- [x] Boot jitter spreads starts over ~5 min (random spread; `AGENT_ID`=container hostname, Launch Pad injects no replica index — answers open Q#3)
- [~] At least one autonomous coffee-shop PR cycle — wired + documented; live run deferred (needs a real target repo + Cursor spend)
- [x] Entire stack deploys with `launchpad deploy` from `examples/swarm` (`wal` + `engineer` deployed live to a throwaway cluster; HTTPS via Let's Encrypt, WSS morph through Caddy, sticky volume)

## Live verification (2026-06-27)

Deployed to a throwaway cluster (`swarm-verify`, edge t3.nano + 1 app t3.small), verified end-to-end,
torn down:

- ✅ `wal` Bun bundle image built + deployed; **HTTPS with a real Let's Encrypt cert**.
- ✅ orbital UI SSR + `/static/station.js` + `/styles.css` over HTTPS; control plane (`/run`,
  `/control`, `/mission`, `/agents`, `/wal`) over HTTPS.
- ✅ **WSS morph through Caddy** — `agents-grid` re-rendered live after an HTTPS heartbeat.
- ✅ SQLite sticky volume survived a container restart.
- ✅ 1 `engineer` replica built + ran on the app node, cloned its repo, registered in the grid, and
  obeyed the control plane (paused ⇒ no cursor-agent / no spend).
- ⚠️ This surfaced + led to fixing a **core Launch Pad bug**: a second cluster's auto-edge (`edge-1`)
  hijacked the default cluster's edge SG + Elastic IP. Production was recovered; SG/EIP are now
  cluster-scoped (`securityGroupName(nodeId, clusterId)` + cluster-filtered `findNodeEip`; regression
  test in `packages/cli/src/provision/security-group-name.test.ts`).
