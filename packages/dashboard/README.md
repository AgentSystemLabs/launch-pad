# Launch Pad Dashboard

A local web dashboard for [Launch Pad](../../README.md) — manage clusters, nodes, and
projects; deploy services; edit env; watch CPU/memory; and tail logs, all from the browser.

It **drives the `launch-pad` CLI** as a subprocess (`--json` / `--yes`) — it never touches
AWS or Docker directly. The CLI is the single integration surface, so the dashboard inherits
exactly the behavior, auth, and safety of the command line.

Built on [orbital-js](../../../orbital-js) (Bun + Hono realtime SSR). State changes broadcast
over a WebSocket and the DOM is morphed in place — no polling, no client API contracts.

```
Browser ──WS(orbital morph)──▶ dashboard (Bun) ──spawns──▶ launch-pad … --json ──▶ AWS
```

## Prerequisites

- **Bun** ≥ 1.1 (orbital requires the Bun runtime).
- The launch-pad CLI + shared package **built**: from the repo root run `pnpm install && pnpm build`
  (produces `packages/cli/dist/index.js` and `packages/shared/dist`).
- **AWS credentials** in your shell (`AWS_PROFILE` / `AWS_REGION` or SSO) — the dashboard
  spawns the CLI which uses them. For deploy/scaffold you also need a running **Docker** daemon.

This package is intentionally **excluded from the pnpm workspace** (it is Bun-managed); it links
the CLI's shared package and orbital's station package via `file:` deps.

## Run

```bash
cd packages/dashboard
bun install            # resolves the file: links to ../shared and ../../../orbital-js/...
bun run dev            # tailwind watch + server → http://127.0.0.1:4000
```

Then open <http://127.0.0.1:4000>. The dashboard binds **127.0.0.1 only** (no auth — it acts as
you, with your local AWS credentials).

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | listen port |
| `LAUNCH_PAD_DASHBOARD_HOST` | `127.0.0.1` | bind interface |
| `LAUNCH_PAD_BIN` | `node ../../cli/dist/index.js` | override the CLI entry (a `.ts`/`.js` path runs under the current runtime; anything else is treated as an executable) |
| `LAUNCH_PAD_DASHBOARD_HOME` | `~/.launch-pad-dashboard` | where the dashboard stores its config (registered projects + default cluster) |

The dashboard's only persisted state is the **registered projects** (host directories with a
`launch-pad.toml`) and the default cluster/profile/region. AWS remains the source of truth for
everything else.

## What each page does

| Page | Backed by |
|------|-----------|
| **Clusters** | `cluster list` / `create` / `destroy`; "Use" sets the active cluster locally |
| **Nodes** (per cluster) | `node list` / `create` / `pause` / `resume` / `resize` / `destroy` |
| **Projects** | register an existing project dir, scaffold a new one (`init`), `deploy`, and edit env (`launch-pad.toml` → `deploy`) |
| **Services** (per cluster) | aggregates `status --node` across the cluster's nodes; redeploy |
| **Monitor** (per node) | live `node monitor --watch` (falls back to `--since` history for stopped nodes), SVG CPU/mem charts |
| **Logs** (per project/service) | live `logs --follow`; requires the project to be registered (the CLI resolves the project from `launch-pad.toml` in its cwd) |

Monitor and Logs use **one shared CLI subprocess per (cluster, resource)**, ref-counted across
viewers and torn down when the last viewer leaves or navigates away.

## Tests

End-to-end tests (Playwright) run the whole UI against a **fake CLI** (no AWS needed): the
dashboard is started with `LAUNCH_PAD_BIN` pointed at `tests/fake-cli/launch-pad.ts`, which emits
the same `--json` shapes as the real CLI and persists mutations so create/destroy/list flows are
coherent.

```bash
bunx playwright install chromium   # once
bun run test:e2e
```

## Notes / limitations (v1)

- Localhost + no auth by design. Don't expose it publicly without putting auth in front.
- Deploy / node-create are long-running; the submit button stays disabled until the CLI returns.
- `launchpad logs` needs a registered project directory (it derives the project from the toml).
