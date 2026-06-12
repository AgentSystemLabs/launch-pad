# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Launch Pad** is a self-hosted deploy tool: one command (`launchpad deploy`) builds a
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

# Link the CLI globally from another directory (no build — runs TypeScript via tsx)
npm link                              # from repo root; bins invoke packages/cli/src on every run
# Test the compiled artifact instead: pnpm link:dist
```

Package names: `@agentsystemlabs/launch-pad` (cli), `@agentsystemlabs/launch-pad-agent`
(the Rust agent, dir `packages/agent-rust`), `@agentsystemlabs/launch-pad-shared` (shared).
The agent is **Rust** — `cargo test` / linux binaries via `pnpm test:agent` /
`pnpm build:agent` (needs rustup + cargo-zigbuild); `pnpm build`/`test` stay TS-only.

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
`merge.ts` (ownership-aware desired-state merge: `mergeProjectServices` REPLACES a project's
whole footprint on a node for a full deploy; `mergeProjectServicesPartial` UPSERTS for a subset
deploy), `health.ts`, `constants.ts`, `cron.ts` (zero-dep 5-field UTC cron evaluator —
validation for the CLI, `dueCronFire`/`nextCronFire` for the agent's scheduled jobs),
`autoscale.ts` (reactive autoscaling: the policy schema persisted in `cluster.json`, the
pure `planAutoscale` planner — one action per pass, cooldown, conservative on missing
metrics — and `scaleOutNodeSpec`), `node-names.ts` (generated `<noun>-<verb>-<adverb>`
node names — used everywhere the system invents a node id: `node create` without a name,
deploy's bootstrap/auto-add, autoscale scale-out; the dedicated edge keeps `edge-1`).

- `PROTOCOL_VERSION` (constants.ts) must be bumped whenever the wire shape of
  `desired.json`/`status.json` changes. It is `2` (v2 dropped the `both` role / co-located
  Caddy and made `ingress.edge` a required node id).
- Within a protocol version, schema changes must be **additive and backward-compatible** —
  new fields use `.default()` so old documents still parse. This is load-bearing for live
  nodes.

### `packages/cli` — the product surface (`commander`-based)

What the user runs. Commands: `init` · `doctor` · `setup` · `deploy` · `destroy` ·
`rollback` · `rebalance` · `autoscale` · `status` · `history` · `node` · `project` · `cluster` (registered
in `src/index.ts`). Named environments are `deploy --env` + `destroy --env` (no separate
command): an env deploy writes a
`projects/<owner>/preview.json` marker (shared `preview.ts`: zod schema, `parsePreviewTtlMs`
for `deploy --ttl 30m/72h/7d`, expiry + prune planners — the internal env registry; "preview"
is the legacy internal name, never user-facing. CLI-only state — the agent never reads it, so
no PROTOCOL_VERSION bump; legacy markers' `dns` array parses but is ignored). **Launch Pad
never writes DNS** — it's user-managed (one wildcard DNS-only A record at the edge's EIP
covers every env subdomain); deploy prints the targets (`deploy/dns-panel.ts`) and
`dns verify` checks them. `destroy --list-envs` enumerates markers; `destroy --env <name>`
undeploys the env footprint (reusing the ownership-scoped `planUndeploy`/`applyUndeploy`)
and sweeps the footprint's `projects/`
prefix; `destroy --prune-expired` is one cron-able pass destroying every TTL-expired env
(dry-run without `--yes`; `--json` requires `--yes`; a failed teardown keeps its marker so the
next pass retries). Only marker-backed envs are destroyable via `--env` — never the base
project's footprint.
`autoscale` is reactive node-pool autoscaling with no daemon: the policy
(min/max app nodes + utilization thresholds) lives in `cluster.json`; `autoscale run` is one
cron-able reconcile pass that reads each node's live host sample from `status.json`, asks the
pure planner for at most ONE action, CAS-claims `lastScaleAt` (ifMatch — overlapping passes
abort, crashed passes stay cooled down) and then provisions the next app node + rebalances,
or drains the least-utilized node (rebalance `--drain` + convergence wait + victim drain-grace
wait so the upstream shard is retracted) before teardown. Scale-in refuses the cluster's
edge, any node still hosting another project's / a volume-bearing service, and any victim
whose **reserved** footprint the survivors can't absorb (live utilization never overrides
the capacity admission check — `publishDesired`'s `assertCapacity` would refuse the drain).
`rebalance` replans the footprint's services across the current app pool and
republishes (reusing published images, no rebuild; gainers before reducers; vacated nodes
cleaned) — config-lock-safe (only placement changes), eventually-consistent (agents reconcile on
poll, no cross-node health-gate). `node evacuate <node>` = `rebalance --drain <node>` (refuses to
move a volume-bearing service or drain the last app node). `node destroy --evacuate` chains the two:
`assessEvacuation` (pure, in `commands/node/index.ts`) splits each doomed node's hosted services
into movable (this project's volume-less services) vs. unmovable (volume-bearing / other-project), then
`runRebalance` drains the whole target set at once (`drainNodes`) and `wait`s for convergence
(`waitForConvergence`) before teardown — a typed `EvacuationBlockedError` (volumes-on-drain /
last-app-node) is caught so the orphan gate decides rather than crashing. `node resize
--evacuate` is the non-disruptive vertical scale: drain (wait) → stop/retype/start →
rebalance back (wait); its pure planner `planResizeEvacuation` (`commands/node/
resize-evacuate.ts`) refuses a paused node or a volume-bearing service up front. Pure diff in
`deploy/rebalance-plan.ts` (`diffPlacement`); deploy's candidate-node + capacity-snapshot
construction is the shared `deploy/candidate-nodes.ts` (`buildCandidateNodes`/`demandsOf`). `setup iam-policy` /
`setup github-oidc` are pure generators (`src/setup/*`) — a least-privilege operator IAM policy
and a GitHub-OIDC trust policy + deploy workflow — for AWS/CI onboarding without
`AdministratorAccess`. `history` reads a footprint's append-only
deploy events (`shared/src/events.ts`; written best-effort by `deploy`'s `recordDeployEvent`). `destroy` (no `--env`) is the inverse of `deploy` — it drops a
project (or one `--service`) from each node's `desired.json` and **trims the config baseline** so
removing a service isn't config-lock-blocked (pure planning in `shared/src/undeploy.ts` —
the shared planner keeps the undeploy name; CAS-guarded S3 writes in `commands/destroy.ts`
`applyUndeploy`). `rollback` redeploys a
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
the config before publishing (spend-gated: `--yes` / `--no-create` / `--dry-run`), including
the cluster's **dedicated edge** (`edge-1`, `DEFAULT_EDGE_INSTANCE_TYPE` t3.micro) when the
cluster doesn't have one — every deploy needs at least 2 nodes (edge + ≥1 app). Two no-build
redeploy paths skip buildx and reuse an existing image, pinned to the published placement:
`--restart` (republish the current image with a `restartAt` bump to roll containers for an
env/secret change) and `--image <uri>` (redeploy a specific existing immutable ECR tag of one
`--service` — rollback / promote; validated to that service's own repo via
`shared/src/ecr.ts` `parseEcrImageUri`). The shared `reuseExistingImages` flag gates the
skip-build + pin-to-published-placement behavior for both. `--remote-build` swaps local buildx
for **AWS CodeBuild** (slim CI runners, no docker daemon): pack the context tarball
(`deploy/context-pack.ts` — honors `.dockerignore` literals + root globs + `**/` forms for the
upload so secret-guarding globs keep files out of S3, but the dockerfile + `.dockerignore`
always ship since docker reads both out-of-band), upload it under the footprint's `builds/`
S3 prefix (deleted post-build), and run one build in the per-cluster
`launch-pad-build-<cluster>` CodeBuild project (created on first use with a least-privilege
service role that can read ONLY its own cluster's `builds/*`, never desired/status; removed —
with its log group — by `cluster destroy`), producing the same immutable linux/amd64 tag.
Pure planning in `deploy/remote-build.ts`, AWS calls in `aws/codebuild.ts`; the buildspec
pushes in the SAME phase as the build (CodeBuild still runs post_build after a failed build)
and retries the build 3× with backoff (Docker Hub 429s CodeBuild NAT IPs — docs recommend
`public.ecr.aws/docker/library/*` base images).
`--changed <ref>` (monorepo
"deploy only what changed") narrows the deploy to services whose docker **build inputs**
differ from a git ref — pure mapping in `deploy/changed-services.ts` (`selectChangedServices`
over each service's repo-relative `context`/`dockerfile`, with `collectChangedPaths` unioning
`git diff <ref>` + untracked files); zero changed services is a clean exit-0 no-op.

- `src/aws/*` — thin AWS SDK clients (ec2, ecr, iam, ssm, s3-state, codebuild, sts via `context.ts`).
- `src/provision/*` — node bootstrap generation: `user-data.ts` (role-specific cloud-init —
  no Docker/Node on edge, no Caddy/Node on app), `systemd-unit.ts` (role-aware unit running
  `/opt/launch-pad/agent`; docker dep only on app), `agent-bundle.ts` (resolves the prebuilt
  linux binaries from `packages/agent-rust/dist/`), `golden-ami.ts` (ROLE-keyed manifest v2:
  `amis.edge[region]`/`amis.app[region]` — `resolveNodeAmi(role)` picks automatically; users
  never choose unless they pass `--ami`). **The agent is NOT distributed via npm** — the
  role-specific binary is uploaded to `nodes/<id>/agent` in S3 and the node `curl`s it via a
  presigned URL embedded in user-data (or it's pre-baked in the role's golden AMI), then runs
  under **systemd**. `node upgrade-agent` migrates a live node in place (rewrites the unit,
  installs the role binary, sets `agentType: "rust"`, stops Docker on an edge); `doctor`
  warns on remaining `agentType: "ts"` nodes.
- `src/deploy/*` — `placement.ts` (the capacity scheduler: headroom bin-packing + sticky
  single-node placement for volume services), `provision-plan.ts` (pure provision plan:
  `planEdgeAction` for the dedicated edge + auto-sized app nodes), `watch.ts` (status polling).
- `src/cluster/`, `src/config/local.ts` — `~/.launch-pad/config.toml` (LOCAL prefs only:
  cluster → AWS target). **S3 is the authoritative registry; local config is never the source
  of truth for what exists.**

### `packages/agent-rust` — the node reconciler (the only thing that touches Docker + Caddy)

**Rust**, one crate, two role-specific static binaries (`src/bin/agent-app.rs` /
`src/bin/agent-edge.rs`, cargo features `app`/`edge`; `cargo test` runs with both). The
**app** binary's tick: read `desired.json` → `plan_reconcile` (pure, in `reconcile.rs`;
includes `plan_cron_service`) diffs desired vs. live containers → `apply_actions`
(start/stop/replace via `docker.rs` subprocess calls, ECR auth via `ecr.rs`, SSM secrets via
`secrets.rs`) → publish upstream shards → write `status.json` + heartbeat (`status.rs`,
`status_write.rs`). The **edge** binary reads only its own `upstream/*` shards and programs
**Caddy** via its admin API (`caddy.rs`, routes in `routes.rs`) — and probes Caddy's LIVE
config each tick (`GET /config/`), so a Caddy restart out from under the agent is force
re-pushed within one poll (never trust only the last-pushed cache). Docker/ECR/SSM code and
deps are compiled OUT of the edge binary; both binaries fail closed on a role-mismatched
`agent.json`, and the app binary refuses to start without Docker. Local port allocation +
cron fire anchors persist in `state.rs` (atomic rename) so it self-heals across reboots.
The agent is **idempotent and crash-safe** — running it twice against the same desired state
is a no-op; it reconciles back after any disruption. Keep it that way. Status/shard
fingerprints and `configStamp` labels are **byte-identical** to the retired TypeScript
agent (golden-hash tests) so a TS→Rust upgrade never rolls containers — keep that parity
when touching `service_config_stamp` or the fingerprint payloads.

- **Write-on-change S3 publishing** (`status_write.rs`): the agent reconciles every tick but
  only PUTs `status.json` / `upstream/*.json` when their *meaningful* content changes — a
  content fingerprint strips timestamp-only fields (`lastSeen`, per-service `updatedAt`,
  `caddy.lastReloadAt`). Between changes it still re-publishes status as a **liveness
  heartbeat** every `LIVENESS_HEARTBEAT_MS` (30s; env `LAUNCHPAD_LIVENESS_MS`) so the CLI's
  `isHeartbeatStale` (`HEARTBEAT_STALE_MS`, 60s) stays reliable — liveness is clamped to ≤ half
  the stale window and only fires per tick, so a coarse `LAUNCHPAD_POLL_MS` is warned about at
  startup. Mid-rollout `heartbeat()` and the whole-tick error path always write (skip-proof).
  The edge node also reuses a per-tick **shard-list cache** (ETags from the LIST) to skip
  redundant shard GETs. `LAUNCHPAD_DEBUG_S3=1` logs written-vs-skipped PUTs per tick.
  `status.json` also embeds the node's latest **host utilization sample** (`host`, sampled by
  the stats sampler each interval, excluded from the change fingerprint) — the live signal
  `launchpad autoscale run` reads from S3 without CloudWatch or new IAM.

### State layout in S3 (one bucket per account+region, `s3-keys.ts`)

```
launch-pad-state-<acct>-<region>/
  nodes/<id>/{node,desired,status}.json   # the implicit `default` cluster (legacy, un-prefixed)
  projects/<footprint>/config-baseline.json   # config-lock baseline (default cluster)
  projects/<footprint>/events/<ts>-<id>.json  # append-only deploy history (`launchpad history`)
  projects/<footprint>/builds/<svc>/<tag>.tar.gz  # transient --remote-build context (deleted post-build)
  projects/<footprint>/preview.json           # env marker (`deploy --env`; read by `destroy --env/--list-envs/--prune-expired`)
  projects/_index/<project>.json              # component registry for federated deploys (CLI-only; shared/src/project-registry.ts)
  clusters/<clusterId>/
    cluster.json
    nodes/<id>/{node,desired,status}.json
    nodes/<edge-id>/upstream/<app-node-id>.json   # push-based routing shards
    projects/<footprint>/{config-baseline.json,preview.json,events/}   # per-footprint state, cluster-scoped
```

The `default` cluster keeps the legacy un-prefixed `nodes/` root so pre-cluster nodes need no
migration. State lives under `nodes/` (the machine is the durable identity), not `agents/`.

## Cross-cutting invariants (don't break these)

- **Node roles** (`edge` | `app`): `edge` = the cluster's single dedicated Caddy router, no
  containers, public 80/443 + Elastic IP (t3.micro by default). `app` = containers only,
  private (no public 80/443, no Elastic IP; reachable only by the edge's security group over
  the VPC at `privateIp`). **Caddy NEVER co-locates with app containers** — there is no
  `both` role; every cluster is at least 2 nodes (1 edge + ≥1 app), both auto-provisioned by
  the first deploy when missing.
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
  `replicas = 1`. Workers need no health check. A worker with a `cron` expression is a
  **scheduled job**: the agent runs one container per fire (`--restart no` + a
  `launchpad.cronFire` label recording the fire time) and judges it by exit code — no
  healthCheck, `replicas` fixed at 1, no overlap (an in-progress run suppresses the next
  fire), missed fires collapse to the latest one, and a new schedule is anchored at first
  sight (never replays history). The cron expression is config-locked identity. Deploy and
  rebalance watch a cron service with `expectedReplicas = 0` (armed = state "running"), and
  a failed run surfaces via `cron.lastExitCode` in status — never state "error" — so one
  bad run can't wedge a later deploy's convergence. Keep all of that intact.
- **Capacity:** `cpu` is vCPU shares (1024 = 1 vCPU), `memory` is MB. Deploy runs a capacity
  admission check (with reserved host headroom) before publishing. It reserves the **rollout
  surge** too: steady-state demand plus the single largest per-service surge
  (`min(maxSurge, replicas) × footprint`), maxed per resource because a node rolls one
  service at a time. `checkCapacity` (shared) and the auto-provision sizing
  (`smallestInstanceTypeFor`) both size for this peak, so a deploy can always surge.
- **Placement is scheduler-only** (planned by `cli/src/deploy/placement.ts`
  `planClusterPlacement`): there is NO user-facing node pinning — `node`/`nodes`/`edge`/
  `topology`/`schedule` are rejected TOML keys (migration hints in `DEPRECATED_SERVICE_KEYS`).
  The scheduler bin-packs by free headroom — spreads multi-service deploys across empty nodes
  and stacks replicas on one node only when necessary — and uses `checkCapacity`'s exact
  steady + largest-single-surge math so a planned placement can never fail the admission
  pre-flight. Capacity pressure auto-adds app nodes. A service with
  `[[service.volumes]]` is **sticky single-node**: all replicas land on ONE node and later
  plans keep it there (`stickyNodeId` from the published footprint); a full sticky node is a
  plain `CliError` (auto-add can't fix it — the data can't move), and rebalance/evacuate/
  autoscale refuse to move it. Web services always route through the cluster's dedicated edge
  (`ingress.edge` = its node id, required on the wire). Deploy must clean a vacated node's
  desired.json when placement moves (skipped for `--service`/`--changed` partials), and
  `deploy --restart` pins to the published footprint so a re-plan can't move services.
- **Partial (subset) deploys** (`deploy --service` / `deploy --changed`, and the `scale`/`config
  set` edits that wrap a single-service deploy): the per-node publish must **upsert** the
  project's services (`mergeProjectServicesPartial`), never replace its whole footprint. A subset
  deploy only knows the service(s) it republishes; full-replacing would silently drop the
  project's *other* services co-located on that node and the agent would tear down their
  containers next poll. `publishDesired(..., partial=true)` selects the upsert; `capacityDemands`
  takes the same `partial` flag so the pre-flight still counts the preserved siblings. A FULL
  deploy keeps replace semantics (a service dropped from the config is removed). `deploy
  --changed <ref>` derives its subset from a git diff; with zero changed services it's a no-op
  that exits 0 (CI-safe) — see `deploy/changed-services.ts` (pure mapping by build context /
  dockerfile).
- **Config lock** (`shared/src/config-lock.ts`): after a footprint's first deploy, only the
  **operational** fields may change — `cpu`, `memory`, `replicas`, `env`, `secrets` (key
  names), `domain`, and `domainPattern`. Identity/shape is frozen (`port`,
  `dockerfile`/`context`, `healthCheck`, `rollout`, `cron`, add/remove/rename a service); an
  identity change aborts deploy before the build, with no bypass flag. Old baselines may
  still carry the removed `node`/`nodes`/`edge`/`schedule`/`topology` fields — they parse but
  are stripped from the lock view (never a violation). The mutable set is the single list
  `lockedServiceView` strips and `CONFIG_LOCK_MUTABLE_HINT` names — keep the two in
  lock-step, and mirror new numeric bounds via `SERVICE_NUMERIC_FIELD_MIN` (shared) so the
  `scale`/`config` CLI edits (`cli/src/config/toml-edit.ts`) can't write a value the next
  deploy's parse rejects. `scale` and `config set` just edit `launch-pad.toml` for the
  allowed fields and re-run a single-service deploy.
- **Components (federated multi-repo deploys):** an optional top-level `component` TOML
  field makes the footprint owner the derived `<project>--<component>` —
  `footprintOwner(config, env)` (`shared/src/config.ts`) is the SINGLE derivation point
  every footprint-scoped command uses; **never parse an owner string back apart** — the
  per-project component index (`projects/_index/<project>.json`,
  `shared/src/project-registry.ts`, CAS-written on deploy) is the owner → (project,
  component) mapping. Because everything scopes by owner, sibling components are "other
  projects" to merge/undeploy/lock/secrets automatically. Service names must stay unique
  across a project's components (shared ECR namespace `<project>/<service>` — ECR keys by
  `config.project`, NOT the owner); deploy enforces this against the index pre-build.
  `--` is reserved (rejected inside `project`/`component`). `project show` aggregates via
  the index; `destroy --project` fans out over it.
- **Config format is `launch-pad.toml`** (TOML via `smol-toml`), multi-`[[service]]`,
  multiple projects per node. ⚠️ The "reference shapes" section of `docs/overview.md` still
  shows a single-service `launchpad.yaml` — that is stale; the real schema is
  `shared/src/config.ts` (`LaunchPadConfigSchema`). The TOML/clusters/edge sections of the doc
  are current.

## Testing conventions

Vitest, co-located `*.test.ts` files (TS packages); `cargo test` with co-located `#[cfg(test)]`
modules for the Rust agent (`pnpm test:agent`). The pure planners are the heavily-tested seam —
prefer adding logic to pure functions (`reconcile.rs`/`plan_reconcile`, `cron.rs`,
`status_write.rs`, `placement.ts`, `provision-plan.ts`, `capacity.ts`, `merge.ts`,
`s3-keys.ts`) and testing those directly, rather than testing through AWS/Docker
side-effecting code. Shared `cron.ts` and the agent's `cron.rs` are a deliberate
two-implementation pair — port test/behavior changes to both. `examples/web-worker` is the
end-to-end fixture every feature is validated against (a tiny Express app that handles
`SIGTERM` for graceful drain).

## Operational gotchas (learned from live deploys)

- The node IAM policy **must** include `s3:ListBucket` on the bucket, or a `GetObject` on a
  not-yet-existing `desired.json` returns 403 (not 404) and a fresh node can't reconcile.
- Caddy auto-HTTPS uses Let's Encrypt HTTP/TLS challenges, so the service domain must resolve
  **directly** to the node — a record fronted by a proxy/CDN breaks issuance.
- `user_data.sh` runs `set -euxo pipefail`; any failed command aborts cloud-init and the agent
  never installs. Ordering matters (e.g. `mkdir -p /etc/launch-pad` before writing configs).
  Diagnose a no-show agent via EC2 console output / a missing `status.json`.
