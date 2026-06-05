# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Launch Pad** is a self-hosted deploy tool: one command (`npx launch-pad deploy`) builds a
user's app into a Docker image, pushes it to **ECR**, provisions **AWS** (EC2 + IAM + S3),
runs it on the user's own node behind **Caddy** with automatic HTTPS, and auto-updates on the
next deploy. The north-star spec is `docs/overview.md` — read it before non-trivial work.

The whole system is **declarative, with no control-plane server**: the CLI writes *desired
state* to S3; an agent on each node polls S3 and *reconciles* Docker + Caddy to match. S3 is
the only thing the two sides share.

```
CLI (local) ──writes desired.json──▶ S3 ◀──polls desired.json── agent (on node)
CLI (local) ◀──polls status.json──── S3 ──writes status.json──▶ agent (on node)
```

## Commands

pnpm workspace (Node ≥ 24, pnpm 11). Run from the repo root unless noted.

```bash
pnpm build            # build all packages (tsup) — see ordering note below
pnpm typecheck        # tsc --noEmit across all packages
pnpm test             # vitest run across all packages
pnpm dev              # all packages in watch/run mode in parallel
pnpm clean            # remove dist / tsbuildinfo

# One package
pnpm --filter @agentsystemlabs/launch-pad-shared test
pnpm --filter @agentsystemlabs/launch-pad        typecheck

# One test file / one test name (extra args forward to vitest)
pnpm --filter @agentsystemlabs/launch-pad-shared test src/config.test.ts
pnpm --filter @agentsystemlabs/launch-pad-shared test -- -t "capacity"

# Run the CLI locally without building (workspace dev)
pnpm --filter @agentsystemlabs/launch-pad dev -- deploy --dry-run
```

Package names: `@agentsystemlabs/launch-pad` (cli), `@agentsystemlabs/launch-pad-agent`
(agent), `@agentsystemlabs/launch-pad-shared` (shared).

**Build ordering gotcha:** `typecheck` works on a clean tree (each package's tsconfig maps
`@agentsystemlabs/launch-pad-shared` to `../shared/src/index.ts` via `paths`). But **runtime**
resolution — `pnpm dev`, the built binaries, and `cli`/`agent` **vitest** runs — goes through
`node_modules` → `packages/shared/dist`. So after editing `shared`, rebuild it
(`pnpm --filter @agentsystemlabs/launch-pad-shared build`) before running cli/agent tests or
they exercise stale shared code. There is **no linter/formatter** configured — match existing
style by hand; tsconfig is `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.

## Architecture

Three packages plus a shared contract. The clean boundary: **CLI publishes desired state ·
Agent reconciles the node · Shared is the contract.**

### `packages/shared` — the typed contract (import-only source of truth)

Every shape that crosses the CLI ↔ agent boundary is a **Zod schema** here, exported from
`src/index.ts`. Both sides import it so they cannot drift; a mismatch becomes a parse error,
not a silent hung deploy. Key modules: `config.ts` (the `launch-pad.toml` schema —
`ServiceDecl`/`LaunchPadConfig`), `desired.ts` (`desired.json`), `status.ts` (`status.json`),
`registry.ts` (`node.json`), `cluster.ts`, `s3-keys.ts` (all S3 key derivation), `edge.ts`
(upstream-shard routing types), `capacity.ts` (admission check + instance sizing),
`merge.ts` (ownership-aware desired-state merge), `health.ts`, `constants.ts`.

- `PROTOCOL_VERSION` (constants.ts) must be bumped whenever the wire shape of
  `desired.json`/`status.json` changes.
- Schema changes must be **additive and backward-compatible** — new fields use `.default()`
  so old documents still parse. This is load-bearing for live nodes.

### `packages/cli` — the product surface (`commander`-based)

What the user runs. Commands: `init` · `deploy` · `status` · `node` · `cluster` (registered
in `src/index.ts`). `cluster use <name>` persists a local `defaultCluster` (cleared by `use
default`) and `cluster current` shows the effective target; AWS-touching commands print a
`cluster: <id>` banner line (`banner.ts` + the `preAction` hook). `node upgrade-agent`
publishes a fresh agent bundle to S3 and restarts the on-box agent via SSM (with manual
fallback). `deploy` is the heart: load `launch-pad.toml` → docker buildx
(`linux/amd64`) → push to ECR with an **immutable content-addressed tag** (git SHA / content
hash, **never `:latest`**) → capacity admission check → ownership-aware **merge** into the
node's `desired.json` (never clobbers other projects' services) → conditional S3 write → watch
`status.json` to convergence. It also **auto-provisions** missing/paused nodes referenced by
the config before publishing (spend-gated: `--yes` / `--no-create` / `--dry-run`).

- `src/aws/*` — thin AWS SDK clients (ec2, ecr, iam, ssm, s3-state, sts via `context.ts`).
- `src/provision/*` — node bootstrap generation: `user-data.ts` (cloud-init), `systemd-unit.ts`,
  `agent-bundle.ts`. **The agent is NOT distributed via npm** — it's bundled to one
  self-contained CJS file, uploaded to `nodes/<id>/agent.cjs` in S3, and the node `curl`s it
  via a presigned URL embedded in user-data, then runs it under **systemd**.
- `src/deploy/*` — `placement.ts` (replica distribution), `provision-plan.ts` (pure role
  inference + plan), `watch.ts` (status polling).
- `src/cluster/`, `src/config/local.ts` — `~/.launch-pad/config.toml` (LOCAL prefs only:
  cluster → AWS target). **S3 is the authoritative registry; local config is never the source
  of truth for what exists.**

### `packages/agent` — the node reconciler (the only thing that touches Docker + Caddy)

A long-running process; `src/index.ts` is the poll loop. Each `tick()`: read `desired.json` →
`planReconcile` (pure, in `reconcile.ts`) diffs desired vs. live containers → `applyActions`
(start/stop/replace via `docker.ts`, ECR auth via `ecr-auth.ts`) → program **Caddy** via its
admin API (`caddy.ts`, routes built in `routes.ts`) for domain→container HTTPS → write
`status.json` + heartbeat (`status.ts`). Local port allocation persists in `state.ts` so it
self-heals across reboots. The agent is **idempotent and crash-safe** — running it twice
against the same desired state is a no-op; it reconciles back after any disruption. Keep it
that way.

- **Write-on-change S3 publishing** (`status-write.ts`): the agent reconciles every tick but
  only PUTs `status.json` / `upstream/*.json` when their *meaningful* content changes — a
  content fingerprint strips timestamp-only fields (`lastSeen`, per-service `updatedAt`,
  `caddy.lastReloadAt`). Between changes it still re-publishes status as a **liveness
  heartbeat** every `LIVENESS_HEARTBEAT_MS` (30s; env `LAUNCHPAD_LIVENESS_MS`) so the CLI's
  `isHeartbeatStale` (`HEARTBEAT_STALE_MS`, 60s) stays reliable — liveness is clamped to ≤ half
  the stale window and only fires per tick, so a coarse `LAUNCHPAD_POLL_MS` is warned about at
  startup. Mid-rollout `heartbeat()` and the whole-tick error path always write (skip-proof).
  Edge/`both` nodes also reuse a per-tick **shard-list cache** (ETags from the LIST) to skip
  redundant shard GETs. `LAUNCHPAD_DEBUG_S3=1` logs written-vs-skipped PUTs per tick.

### State layout in S3 (one bucket per account+region, `s3-keys.ts`)

```
launch-pad-state-<acct>-<region>/
  nodes/<id>/{node,desired,status}.json   # the implicit `default` cluster (legacy, un-prefixed)
  clusters/<clusterId>/
    cluster.json
    nodes/<id>/{node,desired,status}.json
    nodes/<edge-id>/upstream/<app-node-id>.json   # push-based routing shards
```

The `default` cluster keeps the legacy un-prefixed `nodes/` root so pre-cluster nodes need no
migration. State lives under `nodes/` (the machine is the durable identity), not `agents/`.

## Cross-cutting invariants (don't break these)

- **Node roles** (`both` | `edge` | `app`): `both` = co-located Caddy (default). `edge` = a
  dedicated Caddy router, no containers. `app` = containers only, private (no public 80/443,
  no Elastic IP / auto-assigned public IPv4; reachable only by its edge's security group
  over the VPC at `privateIp`).
- **Push-based routing, never cross-reads:** an `app` agent writes its own *upstream shard*
  into its edge's `upstream/` prefix; the `edge` agent reads only its own `upstream/*`. No node
  ever reads another node's `desired.json`/`status.json`. This is enforced by **per-node
  least-privilege IAM** (`cli/src/aws/iam.ts`) — a node can read its own desired, write its own
  status, and (app) write its shard; ECR pull is account-wide. Preserve this when touching IAM
  or S3 access.
- **Web vs. worker:** a service with both `domain` + `port` is a web service (gets Caddy +
  HTTPS); one with neither is a background worker. The schema enforces "both or neither."
  Every web service **must** declare `[service.healthCheck]` (schema-enforced at *any*
  replica count, not just `> 1`): it gates a surged replica before it joins the LB *and*
  feeds Caddy's active health check, so rolling updates stay zero-downtime even at
  `replicas = 1`. Workers need no health check.
- **Capacity:** `cpu` is vCPU shares (1024 = 1 vCPU), `memory` is MB. Deploy runs a capacity
  admission check (with reserved host headroom) before publishing. It reserves the **rollout
  surge** too: steady-state demand plus the single largest per-service surge
  (`min(maxSurge, replicas) × footprint`), maxed per resource because a node rolls one
  service at a time. `checkCapacity` (shared) and the auto-provision sizing
  (`smallestInstanceTypeFor`) both size for this peak, so a deploy can always surge.
- **Config format is `launch-pad.toml`** (TOML via `smol-toml`), multi-`[[service]]`,
  multiple projects per node. ⚠️ The "reference shapes" section of `docs/overview.md` still
  shows a single-service `launchpad.yaml` — that is stale; the real schema is
  `shared/src/config.ts` (`LaunchPadConfigSchema`). The TOML/clusters/edge sections of the doc
  are current.

## Testing conventions

Vitest, co-located `*.test.ts` files. The pure planners are the heavily-tested seam — prefer
adding logic to pure functions (`reconcile.ts`/`planReconcile`, `placement.ts`,
`provision-plan.ts`, `capacity.ts`, `merge.ts`, `s3-keys.ts`) and testing those directly,
rather than testing through AWS/Docker side-effecting code. `examples/both-node-web-worker` is the
end-to-end fixture every feature is validated against (a tiny Express app that handles
`SIGTERM` for graceful drain).

## Operational gotchas (learned from live deploys)

- The node IAM policy **must** include `s3:ListBucket` on the bucket, or a `GetObject` on a
  not-yet-existing `desired.json` returns 403 (not 404) and a fresh node can't reconcile.
- Caddy auto-HTTPS uses Let's Encrypt HTTP/TLS challenges, so the service domain must resolve
  **directly** to the node — a Cloudflare-**proxied** (orange-cloud) record breaks issuance.
- `user_data.sh` runs `set -euxo pipefail`; any failed command aborts cloud-init and the agent
  never installs. Ordering matters (e.g. `mkdir -p /etc/launch-pad` before writing configs).
  Diagnose a no-show agent via EC2 console output / a missing `status.json`.
