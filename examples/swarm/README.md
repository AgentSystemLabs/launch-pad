# Swarm — operator-driven cursor-agent engineers on Launch Pad

Run **N headless `cursor-agent` engineers** that autonomously improve a target repo
([coffee-shop](https://github.com/YOUR_ORG/coffee-shop)), coordinated through a **single live
operator dashboard**. You set a mission in the UI and click **Run**; agents pick up work, open
small PRs, self-review, and merge — no human review gate. **Pause** is the only operator brake.

```
  https://swarm.example.com/          ← operator UI (Bun + orbital-js, live over WebSocket)
   ├── /            Dashboard: mission editor + Run/Pause + agent grid
   ├── /timeline    WAL activity log (filter by agent)
   └── /agents/:id  one agent: current task + live streaming stdout
        │
        ▼  REST + SQLite (/data/swarm.db on a sticky volume)
  ┌──────────────┐   boot jitter 0–5m
  │  wal service │◀──── engineer_0 … engineer_99   (cursor-agent + MCP)
  └──────────────┘
        │
        ▼  git PRs / issues / merges
   coffee-shop (target repo)
```

## Services Launch Pad runs

| Service | Role |
| ------- | ---- |
| `wal` | Control plane: SQLite, REST + operator UI (orbital-js), sticky volume `/data` |
| `engineer` | Worker replicas; `cursor-agent` loop that obeys the control plane |

## How it behaves (core contract)

- **Empty WAL = agents sleep.** A worker only runs `cursor-agent` when `control.state === "running"`
  **and** an active mission exists (`GET /mission/active` non-null). Otherwise it sleeps
  `IDLE_POLL_SEC` and polls again — **no Cursor spend** until you click Run.
- **Operator owns the mission.** Author it in the UI, click **Set mission** (draft) then **Run**
  (arms it + records `swarm_armed` in the WAL). Each Run is an immutable mission row (history).
- **Pause is the only human gate.** Paused ⇒ in-flight runs finish, no new ones start; worker
  `working` appends return `423` (control-plane / `done` / `boot` / `stdout` still allowed).
- **Live, no polling.** Every WAL append, heartbeat, stdout line, and control change pushes a
  WebSocket DOM morph to the dashboard via orbital-js broadcast keys.

## Quick start

### 1. Build the WAL bundle (once / on change)

The `wal` service is a Bun + `@orbital-js/station` app. orbital-js lives in a sibling repo
outside the Docker build context, so the server is **pre-bundled on the host**:

```bash
cd examples/swarm/wal
bun install
bun run build      # → dist/{server.js,station.js,styles.css}
```

### 2. Configure `launch-pad.toml`

- `swarm.example.com` → your domain (wildcard DNS at the edge EIP)
- `TARGET_REPO`, `GITHUB_REPO` → your coffee-shop remote
- `WAL_URL` → `https://<your-domain>`

### 3. Secrets (on `engineer`)

```bash
cd examples/swarm
launchpad secret set CURSOR_API_KEY --service engineer
launchpad secret set GITHUB_TOKEN   --service engineer   # contents, issues, pull_requests
launchpad secret set GIT_SSH_KEY    --service engineer   # clone/push the target repo
# Optional operator-token gate on the WAL UI mutations:
launchpad secret set OPERATOR_TOKEN --service wal
```

### 4. Deploy + operate

```bash
launchpad deploy --yes
# open https://swarm.example.com  → set a mission → Run
launchpad scale engineer replicas 100
```

## Operator UI

- **Dashboard (`/`)** — mission editor (Set mission / Run ▶), live status pill + Pause/Resume,
  agent grid (id · status · loop · doing · last seen).
- **Timeline (`/timeline`)** — chronological WAL, filter by agent, `done` reports expanded.
- **Agent detail (`/agents/:id`)** — current task + live streaming stdout.

## Autonomous engineering flow

Agents rotate through atomic loops in [`loops/`](./loops) (by replica index). Each loop ends with
a required close-out: `agent_status` heartbeat → stream notable steps via `stdout_append` →
`wal_append done` with a one-paragraph `report` → release locks. The PR lifecycle is fully
autonomous:

- `create-pr` → branch `swarm/<issue>-<slug>`, implement one issue, open PR labeled `swarm`.
- `pr-review` / `self-review` → review + approve without a human.
- `merge-pr` → merge when checks are green. `fix-conflicts` → rebase/resolve.

**Target repo setup:** a deploy key or PAT with **push + merge** rights, and branch protection
configured so the bot can **merge without human review** (or a bypass role for the bot).

## Scale & capacity

`engineer` defaults to `cpu = 1024` (1 vCPU), `memory = 2048` (2 GB). Plan for the steady-state
demand plus Launch Pad's rollout surge headroom:

| Replicas | Reserved (≈) | Notes |
| -------- | ------------ | ----- |
| 5 | 5 vCPU / 10 GB | comfortable on 2–3 app nodes |
| 100 | 100 vCPU / 200 GB | many app nodes — turn on autoscale |

```bash
launchpad scale engineer replicas 100
# Reactive node-pool autoscaling (no daemon; cron the run):
launchpad autoscale set --min-app-nodes 2 --max-app-nodes 30
launchpad autoscale run        # one reconcile pass (cron this)
```

`wal` is a single replica (one SQLite writer) with a sticky `/data` volume — never scale it past 1.
Cursor rate limits, not Launch Pad, are the practical ceiling at high replica counts.

## REST API (agents + curl)

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/healthz` | liveness |
| GET | `/control` | `{ paused, state, activeMission }` |
| POST | `/control/pause` · `/control/resume` | operator (token-gated) |
| GET | `/mission` · `/mission/active` | draft · armed mission |
| POST | `/mission` · `/run` | set draft · arm (token-gated) |
| GET | `/wal?agent=&since=&sinceId=&limit=&order=` | activity feed |
| POST | `/wal/append` | worker writes (`423` while paused, except boot/done/stdout/system) |
| GET | `/agents` · POST `/agents/heartbeat` | grid source · heartbeat |
| GET/POST | `/agents/:id/stdout` | tail · append streamed lines |
| POST | `/locks/acquire\|release\|heartbeat` | SQLite file locks |

Operator-mutating routes (`/run`, `/control/*`, `/mission`) require `x-operator-token` when
`OPERATOR_TOKEN` is set. Agent ingest routes are open (in-cluster only).

## MCP tools (worker → control plane)

`wal_append` (enforces `report` on `done`), `wal_read`, `agent_status` (heartbeat),
`stdout_append`, `lock_acquire`/`release`/`heartbeat`, `github_comment`, `github_add_labels`.

## Local development

```bash
cd examples/swarm/wal
bun install
bun run dev          # server (src/index.ts) + tailwind watch on :8080
bun test             # db + API unit tests
```

The worker scripts (`worker/`) are plain bash + `cursor-agent`; the MCP server (`mcp/`) is Node.

## Open decisions

1. **Auth** — `OPERATOR_TOKEN` gates the API; put real auth (proxy / SSO) in front before
   exposing the UI publicly.
2. **Cursor rate limits** at high replica counts.
3. **Playwright in the worker image** — add Chromium if `ux-review` needs in-cluster browser tests.
