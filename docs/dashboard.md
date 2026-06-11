# Dashboard (work in progress)

A **local web UI** for Launch Pad ([`packages/dashboard`](../packages/dashboard)). It is an
early work in progress — useful, tested, but evolving; the CLI remains the primary surface.

## Design principle: a CLI driver, not an AWS driver

The dashboard never talks to AWS or Docker directly. It spawns the `launch-pad` CLI as a
subprocess with `--json` / `--watch` / `--follow` and renders the output — so it inherits
exactly the CLI's behavior, auth, and safety guarantees, and can never drift from it.

```
Browser ──WS──▶ dashboard (Bun) ──spawns──▶ launch-pad … --json ──▶ AWS
```

## Stack & how to run it

Built on **Bun + orbital-js** (Hono realtime SSR) with Tailwind/DaisyUI. Because orbital-js
requires Bun, the package is **excluded from the pnpm workspace**
(`pnpm-workspace.yaml`) and managed by its own `bun install`:

```bash
cd packages/dashboard
bun install
bun run dev          # → http://127.0.0.1:4000
```

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `PORT` | `4000` | Listen port |
| `LAUNCH_PAD_DASHBOARD_HOST` | `127.0.0.1` | Bind interface — **localhost-only, no auth**; don't expose publicly |
| `LAUNCH_PAD_BIN` | monorepo `packages/cli/dist/index.js` | CLI entry to drive |
| `LAUNCH_PAD_DASHBOARD_HOME` | `~/.launch-pad-dashboard` | Persists registered projects + default cluster/profile/region |

## What it can do today

| Page | Backing CLI |
| ---- | ----------- |
| **Clusters** (`/`) | `cluster list/create/destroy`; "Use" sets the active cluster |
| **Projects** | register existing / scaffold new (`init`), `deploy`, inline `launch-pad.toml` env editing |
| **Nodes** | `node list/create/pause/resume/resize/destroy` |
| **Services** | aggregated `status` across the cluster; redeploy |
| **Monitor** | live `node monitor --watch` CPU/memory charts (historic fallback for stopped nodes) |
| **Logs** | live `logs --follow` tailing |

Long-lived streams (monitor, logs) share **one CLI subprocess per (cluster, resource)**,
ref-counted across viewers and torn down when the last viewer leaves.

## Testing

Playwright e2e specs (one per page) run against the dashboard wired to a **fake CLI**
(`tests/fake-cli/launch-pad.ts`) that emits the same `--json`/NDJSON shapes as the real CLI
and persists mutations to a state file — so create/destroy/list flows are coherent without
touching AWS.

```bash
cd packages/dashboard
bun run test:e2e
```

## Known limitations

- Localhost-only by design; no auth — put auth in front before exposing it.
- Deploys / node creates are long-running CLI calls; the UI disables the submit button until
  the CLI returns.
- `logs` requires a registered project directory (the CLI derives the project from its
  `launch-pad.toml`).
