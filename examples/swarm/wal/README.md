# swarm `wal` — control plane (Bun + orbital-js + SQLite)

The operator UI **and** the agent REST API in one Bun process. State is a single SQLite file on
the sticky `/data` volume (`/data/swarm.db`).

## Layout

```
src/
  index.ts         Bun + Station bootstrap; mounts REST API on station.getApp(); notify→broadcast
  db/migrate.ts    idempotent schema (control, missions, wal_entries, agents, stdout_chunks, locks)
  db/queries.ts    typed data-access helpers (the tested seam)
  api/routes.ts    Hono REST API (control, mission, run, wal, agents, stdout, locks)
  pages/           orbital-js templates + actions (layout, dashboard, wal, agent)
  lib/             AppCtx + small UI helpers
scripts/bundle.ts  build a self-contained dist/server.js for the container image
```

## Develop

```bash
bun install
bun run dev      # server + tailwind watch on :8080
bun test         # db + API unit tests (bun:sqlite in-memory)
bun run typecheck
```

## Build for the image

orbital-js is a **sibling repo** (`file:../../../../orbital-js/packages/station`) outside the
Docker build context, so it can't be `bun install`ed in-image. `bun run build` bundles the server
(inlining orbital + hono) and rewrites the baked station-client path to the container's `dist/`:

```bash
bun run build    # → dist/{server.js,station.js,styles.css}
```

The Dockerfile (`oven/bun`) just copies `dist/` and runs `bun dist/server.js` — no node_modules.

## Locked design decisions (Phase 0)

- **Empty-WAL rule:** a worker runs only when `control.state === "running"` AND
  `control.active_mission_id` points at a mission. Surfaced as `GET /mission/active`.
- **Mission model:** an editable **draft** lives in `meta` (no history spam); each **Run** writes
  an immutable `missions` row and arms it (mission history / versioning).
- **Pause = let in-flight finish.** Pause blocks new `working` appends (`423`); `done`/`boot`/
  `stdout`/`system` and `control-plane` always pass.
- **stdout retention:** capped per agent (`STDOUT_AGENT_CAP_BYTES`, ~256 KB) — oldest pruned.
- **Auth:** `OPERATOR_TOKEN` (header `x-operator-token` / WS `?token=`) gates operator mutations
  (`/run`, `/control/*`, `/mission`); agent ingest is open (in-cluster only).

## Env

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | 8080 | listen port |
| `WAL_DATA_DIR` | `/data` | sqlite dir (`SWARM_DB` overrides full path) |
| `OPERATOR_TOKEN` | _(unset)_ | when set, gates operator mutations |
| `STDOUT_AGENT_CAP_BYTES` | 262144 | per-agent stdout retention |
