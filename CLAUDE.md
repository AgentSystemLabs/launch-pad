# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Launch Pad** is a self-hosted deploy tool: one command (`npx launch-pad deploy`) builds a
user's app into a Docker image, pushes it to **ECR**, provisions **AWS** (EC2 + IAM + S3),
runs it on the user's own node behind **Caddy** with automatic HTTPS, and auto-updates on the
next deploy. The north-star spec is `docs/overview.md` — read it before non-trivial work.

**Start with `README.md`** — it is the documentation directory for the project: intent,
positioning, and a table of per-area deep dives in `docs/*.md`. Before working in an
unfamiliar part of the repo, read the matching doc: `docs/codebase-layout.md` (repo map +
"where to change what"), `docs/architecture.md`, `docs/cli.md`, `docs/configuration.md`,
`docs/agent.md`, `docs/golden-ami.md`, `docs/dashboard.md`, `docs/testing.md`. When a change
alters user-facing behavior (commands, config fields, provisioning, wire contracts), update
the matching `docs/*.md` and, if the surface list changes, the README table.

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

What the user runs. Commands: `init` · `doctor` · `setup` · `deploy` · `undeploy` · `rollback` ·
`rebalance` · `status` · `history` · `node` · `cluster` (registered in `src/index.ts`).
`rebalance` replans the footprint's **cluster-placed** services across the current app pool and
republishes (reusing published images, no rebuild; gainers before reducers; vacated nodes
cleaned) — config-lock-safe (only placement changes), eventually-consistent (agents reconcile on
poll, no cross-node health-gate). `node evacuate <node>` = `rebalance --drain <node>` (refuses to
move a pinned service or drain the last app node). `node destroy --evacuate` chains the two:
`assessEvacuation` (pure, in `commands/node/index.ts`) splits each doomed node's hosted services
into movable (this-project + cluster-placed) vs. unmovable (pinned / other-project), then
`runRebalance` drains the whole target set at once (`drainNodes`) and `wait`s for convergence
(`waitForConvergence`) before teardown — a typed `EvacuationBlockedError` (pinned-on-drain /
last-app-node) is caught so the orphan gate decides rather than crashing. Pure diff in
`deploy/rebalance-plan.ts` (`diffPlacement`); deploy's candidate-node + capacity-snapshot
construction is the shared `deploy/candidate-nodes.ts` (`buildCandidateNodes`/`demandsOf`). `setup iam-policy` /
`setup github-oidc` are pure generators (`src/setup/*`) — a least-privilege operator IAM policy
and a GitHub-OIDC trust policy + deploy workflow — for AWS/CI onboarding without
`AdministratorAccess`. `history` reads a footprint's append-only
deploy events (`shared/src/events.ts`; written best-effort by `deploy`'s `recordDeployEvent`). `undeploy` is the inverse of `deploy` — it drops a
project (or one `--service`) from each node's `desired.json` and **trims the config baseline** so
removing a service isn't config-lock-blocked (pure planning in `shared/src/undeploy.ts`;
CAS-guarded S3 writes in `commands/undeploy.ts` `applyUndeploy`). `rollback` redeploys a
service's previous (or `--to <tag>`) immutable ECR build by delegating to the `deploy --image`
path — it auto-picks the prior tag via `findPreviousImageTag` (shared) over `listRepoImageTags`
(ECR push order). `cluster use <name>` persists a local `defaultCluster` (cleared by `use
default`) and `cluster current` shows the effective target; AWS-touching commands print a
`cluster: <id>` banner line (`banner.ts` + the `preAction` hook). `node upgrade-agent`
publishes a fresh agent bundle to S3 and restarts the on-box agent via SSM (with manual
fallback). `deploy` is the heart: load `launch-pad.toml` → docker buildx
(`linux/amd64`) → push to ECR with an **immutable content-addressed tag** (git SHA / content
hash, **never `:latest`**) → capacity admission check → ownership-aware **merge** into the
node's `desired.json` (never clobbers other projects' services) → conditional S3 write → watch
`status.json` to convergence. It also **auto-provisions** missing/paused nodes referenced by
the config before publishing (spend-gated: `--yes` / `--no-create` / `--dry-run`). Two no-build
redeploy paths skip buildx and reuse an existing image, pinned to the published placement:
`--restart` (republish the current image with a `restartAt` bump to roll containers for an
env/secret change) and `--image <uri>` (redeploy a specific existing immutable ECR tag of one
`--service` — rollback / promote; validated to that service's own repo via
`shared/src/ecr.ts` `parseEcrImageUri`). The shared `reuseExistingImages` flag gates the
skip-build + pin-to-published-placement behavior for both.

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
  projects/<footprint>/config-baseline.json   # config-lock baseline (default cluster)
  projects/<footprint>/events/<ts>-<id>.json  # append-only deploy history (`launch-pad history`)
  clusters/<clusterId>/
    cluster.json
    nodes/<id>/{node,desired,status}.json
    nodes/<edge-id>/upstream/<app-node-id>.json   # push-based routing shards
    projects/<footprint>/{config-baseline.json,events/}   # per-footprint state, cluster-scoped
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
  or S3 access. Shards are re-published at **every rollout surge/drain step** (not just at tick
  end), and the drain wait is floored at the edge's poll cadence (`refreshRouting` /
  `drainFloorMs` in the agent) — otherwise the edge keeps routing to stopped replicas and a
  rolling deploy 502s. Keep that ordering when touching `rolloutService` or shard publishing.
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
- **Cluster auto-placement** (`schedule`/`topology` on a service without `node`/`nodes`,
  planned by `cli/src/deploy/placement.ts` `planClusterPlacement`): `schedule = "even"`
  must stay **byte-identical** to legacy round-robin over the S3-lexicographic app+both
  pool; the `"capacity"` scheduler must use `checkCapacity`'s exact steady +
  largest-single-surge math so a planned placement can never fail the admission
  pre-flight. Topology rides the existing `ingress.edge` tri-state on the wire (no
  protocol change): `"co-located"` = one both-role node, `edge: null` (cluster default
  edge deliberately ignored); `"split"` = app+both nodes behind a required edge. Deploy
  must clean a vacated node's desired.json when placement moves (skipped for
  `--service` partials), and `deploy --restart` pins to the published footprint so a
  re-plan can't move services. `schedule`/`topology` are config-locked like
  `node`/`nodes`/`edge`.
- **Config lock** (`shared/src/config-lock.ts`): after a footprint's first deploy, only the
  **operational** fields may change — `cpu`, `memory`, `replicas`, `env`, and `secrets` (key
  names). Everything else is identity/shape and is frozen (placement, `domain`/`port`,
  `dockerfile`/`context`, `healthCheck`, `rollout`, `schedule`/`topology`, add/remove/rename a
  service); a locked-field change aborts deploy before the build, with no bypass flag. The
  mutable set is the single list `lockedServiceView` strips and `CONFIG_LOCK_MUTABLE_HINT`
  names — keep the two in lock-step, and mirror new numeric bounds via
  `SERVICE_NUMERIC_FIELD_MIN` (shared) so the `scale`/`config` CLI edits (`cli/src/config/
  toml-edit.ts`) can't write a value the next deploy's parse rejects. `scale` and `config set`
  just edit `launch-pad.toml` for the allowed fields and re-run a single-service deploy.
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
