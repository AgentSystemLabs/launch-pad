# Dashboard

A **read-only web viewer** built into the CLI: `launchpad dashboard`. It shows clusters,
nodes, services, environments, deploy history, live CPU/memory, and live logs — and it
**never mutates anything**. Deploys and changes stay in the CLI, your agent workflow, or CI.

```bash
npx @agentsystemlabs/launch-pad dashboard          # → http://127.0.0.1:4000
# or, installed:
launchpad dashboard --project ~/code/my-app        # register project dirs for logs/history
```

## Design principle: a CLI driver, not an AWS driver

The dashboard never talks to AWS directly. It spawns this same `launch-pad` CLI as a
subprocess with `--json` / `--follow` and renders the output — so it inherits exactly the
CLI's behavior, auth, and safety guarantees, and can never drift from it.

```
Browser ──HTTP/SSE──▶ launchpad dashboard (Hono on Node) ──spawns──▶ launch-pad … --json ──▶ AWS
```

Pages are server-rendered (hono/jsx); the two live surfaces (monitor, logs) stream over
**Server-Sent Events**. Long-lived streams share **one CLI subprocess per (cluster,
resource)**, ref-counted across viewers and torn down when the last viewer leaves.

## Pages

| Page | Route | Backing CLI |
| ---- | ----- | ----------- |
| **Overview** | `/` | `node list` + per-node `status` + `destroy --list-envs` — health rollup: running nodes, healthy services, stale heartbeats, an "Attention" list |
| **Clusters** | `/clusters` | `cluster list` |
| **Projects** | `/projects` | registered project dirs (local config) + their `launch-pad.toml` |
| **History** | `/projects/:name/history` | `history` (per registered project) |
| **Nodes** | `/clusters/:c/nodes` | `node list` |
| **Services** | `/clusters/:c/services` | `status` aggregated across the cluster |
| **Environments** | `/clusters/:c/environments` | `destroy --list-envs` (env markers, TTL/expiry) |
| **Monitor** (live) | `/clusters/:c/nodes/:n/monitor` | `node monitor --watch` over SSE (historic fallback for stopped nodes) |
| **Logs** (live) | `/clusters/:c/logs/:p/:s` | `logs --follow` over SSE |

## Options & environment

| Flag / env | Default | Purpose |
| ---------- | ------- | ------- |
| `--port` / `PORT` | `4000` | Listen port |
| `--host` / `LAUNCH_PAD_DASHBOARD_HOST` | `127.0.0.1` | Bind interface — non-loopback **requires** a token |
| `--project <dir...>` | — | Register project directory(ies); `logs`/`history` need a `launch-pad.toml` cwd. The launch cwd auto-registers when it holds one. |
| `--no-open` | — | Don't open the browser |
| `--cluster` / `--profile` / `--region` | CLI defaults | Forwarded to every spawned CLI read |
| `LAUNCH_PAD_DASHBOARD_TOKEN` | — | Enables token auth (see below) |
| `LAUNCH_PAD_DASHBOARD_HOME` | `~/.launch-pad-dashboard` | Where registered projects persist |
| `LAUNCH_PAD_BIN` | self | Override the CLI entry the dashboard spawns (tests) |

## Auth

- **Localhost (default): no auth.** The dashboard binds `127.0.0.1` and is as private as
  your machine.
- **Any other interface requires `LAUNCH_PAD_DASHBOARD_TOKEN`** — the command refuses to
  bind otherwise. With a token set, every page needs it via `Authorization: Bearer`, the
  session cookie, or a one-time `?token=…` (which sets an HttpOnly cookie and redirects).
  Comparison is constant-time; repeated failures are rate-limited per IP.

Because the dashboard is **read-only**, a leaked token exposes *visibility*, not control —
but it still wields your AWS credentials for reads. For a VPS, prefer a private network
(Tailscale/WireGuard) or an authenticating reverse proxy in front, and run it under an IAM
identity scoped to reads.

## Running on a VPS

The dashboard runs anywhere the CLI runs: install Node ≥ 24 +
`@agentsystemlabs/launch-pad`, give the box AWS credentials (an instance profile or a
least-privilege IAM user), set `LAUNCH_PAD_DASHBOARD_TOKEN`, and bind your interface:

```bash
LAUNCH_PAD_DASHBOARD_TOKEN=$(openssl rand -hex 24) \
  launchpad dashboard --host 0.0.0.0 --port 4000 --project /srv/my-app
```

There is still **no control-plane server**: the dashboard is a viewer over the same S3
state the CLI reads. Mutations (deploys, node changes, teardowns) are deliberately absent —
run them from your machine, your agent, or GitHub Actions (`launchpad setup github-oidc`).

## Testing

Playwright e2e specs live in `packages/cli/e2e/`, run against the dashboard wired to a
**fake CLI** (`e2e/fake-cli/launch-pad.mjs` via `LAUNCH_PAD_BIN`) that emits the same
`--json`/NDJSON shapes as the real CLI — so page and live-stream flows are covered without
touching AWS.

```bash
cd packages/cli
pnpm test:e2e
```
