# The node agent

A long-running process on every node — **the only thing that touches Docker and Caddy**.
It reconciles the node to S3's desired state on a **hybrid push + poll** schedule: it polls
S3 every 60s as the durable fallback, and a background task long-polls the node's own SQS
queue for SNS deploy notifications that wake the loop within milliseconds of a deploy (see
[Deploy notifications](#deploy-notifications-snssqs)). The implementation lives in
[`packages/agent-rust`](../packages/agent-rust) (Rust, one crate) and ships as **two
role-specific static binaries**, installed at `/opt/launch-pad/agent` and run under systemd:

- **`launchpad-agent-app`** — the Docker reconciler, on every app node. No Caddy code.
- **`launchpad-agent-edge`** — the Caddy router, on the cluster's dedicated edge. The
  Docker/ECR/SSM paths (and their AWS SDK dependencies) are compiled out entirely, so an
  idle edge agent is a few MB of RSS and the edge AMI doesn't even install Docker.

Each binary **fails closed** when the node's `/etc/launch-pad/agent.json` role doesn't
match (clear error naming the right binary), and the app binary refuses to start without
Docker — a wrong-AMI-for-role provisioning mistake surfaces at first tick, not as silence.

## The reconcile loop (app)

`src/bin/agent-app.rs` runs a poll loop (default 60s, woken early by deploy notifications —
see below). Each tick:

1. Read `desired.json` from S3.
2. Inspect live managed containers (label-based metadata: project, service, replica index,
   image, resources, config stamp).
3. `plan_reconcile` (**pure**, in `reconcile.rs`) diffs desired vs. live and emits actions —
   image/resource/config drift collapses into a single `rollout` action per service.
4. Apply actions via `docker.rs` (pull / run / graceful stop / remove), with ECR auth
   cached ~6h via the instance role (`ecr.rs`).
5. Publish this node's **upstream shard** (its private IP + backend list) into the edge's
   `upstream/` S3 prefix — the routing signal the edge consumes. App nodes never run Caddy.
6. Sample stats, write `status.json` + heartbeat (`status.rs`, `status_write.rs`), and ship
   new log-file lines directly to CloudWatch Logs.

The agent is **idempotent and crash-safe**: running it twice against the same desired state
is a no-op; per-action errors are isolated and the next tick retries from scratch. Local
port allocation (host ports 20000–30000, hashed per service+replica) persists in
`/var/lib/launch-pad/state.json` with atomic renames, so it self-heals across reboots.

## The edge loop

`src/bin/agent-edge.rs` polls only its own `upstream/*` shards (with a LIST-ETag cache that
skips redundant GETs) and programs **Caddy** through its admin API (`caddy.rs`; routes built
in `routes.rs`) for domain → backend HTTPS, with write-on-change reloads.

**Caddy-restart detection:** the agent doesn't trust its own "last pushed" cache — every
tick it GETs `{admin}/config/` (a cheap loopback call) and compares Caddy's LIVE config
against the desired one. If Caddy restarted out from under the agent (crash, OOM,
`systemctl restart caddy`) and reverted to its boot config, the agent force-re-pushes
within one poll cycle. An unreadable admin API also forces a push, so the resulting error
lands in `status.json` instead of being masked by a stale cache.

## Scheduled jobs (cron)

A desired service carrying a `cron` expression bypasses the long-running branches entirely
(`plan_cron_service` inside `plan_reconcile`): one container per fire, started with
`--restart no` and a `launchpad.cronFire=<epoch-ms>` label, judged by exit code. The
due-run decision (`due_cron_fire`, `cron.rs` — a port of shared `cron.ts`, kept in
lock-step) compares the schedule against the last fire, recorded twice for crash-safety:
the run container's fire **label** (survives agent restarts) and `cronFires` in
`state.json` (survives container removal; seeded at first sight so a new schedule never
replays history). The fire is recorded **before** the container starts — a crash between
the two skips a run, never duplicates one. A run still in progress suppresses the next
fire (no overlap), and missed fires collapse to the single latest one (no catch-up storm).
The exited run container is kept until the next fire so its exit code (and CloudWatch
logs) remain inspectable; `status.json` carries a per-service `cron` rollup
(`lastRunAt` / `lastExitCode` / `nextRunAt`). An idle (armed) schedule reports state
`running` — a failed run surfaces via the rollup and message, not state `error`, so a
deploy's convergence watch can't be wedged by one bad run.

## Database backups (app)

A managed-database service (a `[[database]]` block — a long-running Postgres worker with a
`backup` config) layers a **scheduled S3 backup** on top of its normal container reconcile.
`plan_backup_service` reuses the cron evaluator (`due_cron_fire`) against a `backup:<key>`
anchor in `state.json` (namespaced so it never collides with a same-named cron service,
seeded at first sight) and only fires when the DB container is **running** (otherwise it
leaves the anchor untouched and retries next tick — a never-up DB is never silently skipped).

On a fire the agent, per target database (the `databases` list, else every non-template DB
enumerated from the engine — each name re-validated as a Postgres identifier before it can
reach an S3 key): runs `pg_dump -Z 6` (gzip-compressed, **no shell pipe** — so a `pg_dump`
failure is a real non-zero exit, never masked) **inside** the DB container via `docker exec`,
streaming to a `0600` temp file in a `0700` work dir; uploads it with the node's instance
role (no AWS creds ever enter the container; `PGPASSWORD` is passed via the docker process's
env, never argv) to
`launch-pad-backups-<acct>-<region>/<cluster>/<owner>/<service>/<db>/<timestamp>.sql.gz`; then
deletes the temp file and prunes objects older than `retentionDays` under that db's prefix.
The object **timestamp is derived from the scheduled fire** (not wall-clock), so a crash
between upload and recording the fire re-runs and **overwrites** the same keys instead of
duplicating. The fire is recorded **after** the attempt (a DB-up attempt advances the anchor
even if a per-db dump failed — failures surface in the `status.json` `backup` rollup
`lastError`, not as a replayed run). A heartbeat is emitted between databases so a multi-DB
backup doesn't flap the node stale; the backup is still synchronous on the tick, so a very
large dump delays that node's other reconcile work until it finishes. Backup code is compiled
**only into the app binary**.

## Zero-downtime rollouts

`rollout_service` surges a new replica (pull → run → wait for consecutive health-check
passes), refreshes routing **mid-rollout** (the upstream shard is re-published for the edge
at every surge/drain step), then drains the old replica — removed from routing, drain wait
floored at the edge's poll cadence, graceful `SIGTERM` stop. Caddy is tuned for the handoff:
retries, passive failure eviction, and active health probes.

## Status publishing & heartbeats

The agent reconciles every tick but only PUTs `status.json`/shards when their *meaningful*
content changes — a fingerprint strips timestamp-only fields. Between changes it still
re-publishes every `LIVENESS_HEARTBEAT_MS` (30s) as a liveness heartbeat so the CLI's
staleness check (60s) stays reliable; mid-rollout and error paths always write.
`LAUNCHPAD_DEBUG_S3=1` logs written-vs-skipped PUTs per tick.

`status.json` also embeds the node's latest **host utilization sample** (`host`: CPU busy %,
memory used/total MB, `sampledAt`) — the live signal `launchpad autoscale run` reads from S3
without needing CloudWatch. It is telemetry, not convergence state: the fingerprint ignores
it (no PUT storm), so a fresh sample reaches S3 with the next change or liveness heartbeat.

## Deploy notifications (SNS/SQS)

The agent's reconcile loop is **hybrid push + poll**. Polling (`LAUNCHPAD_POLL_MS`, 60s)
is the durable fallback that always converges; on top of it, a deploy *pushes* a
notification so agents react in milliseconds instead of waiting out the interval.

- **CLI side (publish):** each cluster gets one SNS topic `launch-pad-<cluster>`,
  auto-created on first deploy (its access policy locks `sns:Publish` to the account root),
  and its ARN is persisted to `cluster.json`. For every node a deploy writes to, the CLI
  idempotently ensures an SQS queue `launch-pad-<cluster>-<node>`, gives it a resource policy
  allowing **only this cluster's topic** to send (`aws:SourceArn`-conditioned), and subscribes
  it to the topic with raw message delivery. After all desired-state writes land, the CLI
  publishes **one** cluster-wide `config-changed` message (`shared/src/sns-notification.ts`:
  versioned, ISO-8601 timestamp, discriminated union for future types). Pure provisioning in
  `cli/src/aws/sqs.ts`/`sns.ts`; all of it is best-effort — any SNS/SQS failure logs a warning
  and the deploy proceeds, leaving polling to carry the change.
- **Agent side (consume):** a background tokio task (`agent-rust/src/sqs.rs`) resolves its own
  queue by name (retrying with backoff until the CLI has created it), long-polls
  `ReceiveMessage`, deletes drained messages, and fires a `Notify` that cuts the poll loop's
  inter-tick wait short (`runtime.rs` `wait_or_wake`) so the very next tick fetches the new
  desired state. The agent is a pure **consumer** — it never creates the queue or subscribes
  (that needs provisioning-grade IAM); its node policy grants only
  `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueUrl` on its own queue ARN. Both the app and
  edge binaries run the listener (the edge re-reads its upstream shards on wake). A burst of
  messages collapses to a single wake — one reconcile catches up the whole desired state.

**Migration:** existing nodes pick this up via `launchpad node upgrade-agent`, which now also
re-applies the node's inline IAM (adding the SQS receive permission) alongside the new binary.
Until a node is upgraded it keeps converging on the 60s poll. New clusters/nodes get the whole
path automatically on first deploy.

## Secrets, volumes, logs, stats

- **Secrets** (`secrets.rs`): resolves registered keys from SSM Parameter Store at container
  start and merges with plain `env` (plain wins on collision).
- **Volumes** (`docker.rs` `volume_name`/`build_run_args`): mounts a service's declared
  `[[service.volumes]]` as docker named volumes (`launchpadvol_<project>_<service>_<name>`,
  index-independent so the data is re-mounted across rollouts). A `docker rm` leaves the
  named volume intact, so the data outlives a container replacement.
- **Logs** (`cloudwatch_logs.rs`): tails Docker json-file logs plus the forwarded
  journald files under `/var/log/launch-pad` and writes batches directly to CloudWatch Logs
  with the Rust SDK. It keeps the same per-service groups and `node/replica` streams that
  `launchpad logs` already reads, applies 7-day retention on first write, and is
  degraded-safe — logging failures never break reconciliation. BYOS nodes get the small
  journald forwarder during `node init`; older nodes without it can still be inspected with
  `journalctl -u launch-pad-agent` until upgraded/re-enrolled.
- **Stats** (`stats.rs`): samples host CPU/memory (`/proc`) and per-container usage,
  emitting `launchpad.stats` JSON lines (~60s) that reach CloudWatch via the system log
  group — the data behind `launchpad node monitor`. The latest host sample is also
  embedded into `status.json` (see above) for `launchpad autoscale`.

## Configuration (env vars)

| Variable | Purpose |
| -------- | ------- |
| `LAUNCHPAD_POLL_MS` | Poll interval / push fallback (default 60000) |
| `LAUNCHPAD_LIVENESS_MS` | Liveness heartbeat cadence (default 30000, clamped ≤ half the stale window) |
| `LAUNCHPAD_STATS_INTERVAL_MS` | Stats sampling cadence |
| `LAUNCHPAD_STATS_SERVICES` | `0` disables per-container sampling (app) |
| `LAUNCHPAD_ONCE` | Run a single tick and exit |
| `LAUNCHPAD_DEBUG_S3` | Log written-vs-skipped S3 PUTs |
| `LAUNCHPAD_CADDY_ADMIN` | Caddy admin API address (edge; default localhost:2019) |
| `LAUNCHPAD_STATE` | State file path override (app) |
| `LAUNCHPAD_AGENT_CONFIG` | agent.json path override |

Node identity (region, nodeId, clusterId, bucket, role) comes from the config file written
by cloud-init at provision time — unchanged from the TypeScript agent, so upgrades need no
re-provisioning.

## Distribution & migration from the TypeScript agent

The agent is **not on npm**. `pnpm build:agent` cross-compiles both binaries for
linux/amd64 (static musl, ~11 MB each); the CLI uploads the role-appropriate one to
`nodes/<id>/agent` in S3, where cloud-init curls it via presigned URL on full bootstrap (or
the [golden AMI](golden-ami.md) pre-bakes it). `launchpad node upgrade-agent` publishes a
fresh binary and restarts EC2 agents via SSM; named external (BYOS) app nodes use SSH with the
same install script.

**Migrating a live TS-agent cluster** (no re-provision needed):

1. Upgrade the CLI and build the binaries (`pnpm install && pnpm build:agent`).
2. `launchpad node upgrade-agent --yes` — each node downloads the binary for **its** role,
   the systemd unit is rewritten from `node agent.cjs` to the binary, the stale bundle is
   removed, and an edge node additionally stops its now-unneeded Docker daemon.
3. `launchpad deploy` as usual. `launchpad doctor` warns while any node still reports the
   deprecated `agentType: "ts"`.

Container identity is preserved across the migration: the Rust agent computes
matching `configStamp` labels and status fingerprints, so the first Rust tick is normally
a no-op — it does not roll your containers. One narrow exception: a service whose env
keys / secret names mix digits, underscores, and case such that ICU and byte-wise key
ordering disagree (e.g. `DB_HOST` + `DB2_HOST`) gets a single zero-downtime rolling
replace on the first tick, because the old TypeScript agent sorted stamp keys with the
locale-dependent `localeCompare` while the Rust agent sorts deterministically.

## Testing

`cargo test` (in `packages/agent-rust`, or `pnpm test:agent` from the repo root) runs the
ported unit suite — the pure planners (`reconcile`, `cron`, `status_write` fingerprints
with golden hashes, `stats` parsers, `caddy` config + restart detection) are the heavily
tested seam, mirroring the repo's pure-planner testing convention.
