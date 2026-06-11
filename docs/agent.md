# The node agent

A long-running process on every node — **the only thing that touches Docker and Caddy**.
It polls S3 for desired state and reconciles the node to match. The implementation lives in
[`packages/agent`](../packages/agent) (TypeScript, bundled to a single CJS file).

## The reconcile loop

`src/index.ts` runs a poll loop (default 5s). Each `tick()`:

1. Read `desired.json` from S3.
2. Inspect live managed containers (label-based metadata: project, service, replica index,
   image, resources, config stamp).
3. `planReconcile` (**pure**, in `reconcile.ts`) diffs desired vs. live and emits actions —
   image/resource drift collapses into a single `rollout` action per service.
4. Apply actions via `docker.ts` (pull / run / graceful stop / remove), with ECR auth
   cached ~6h via the instance role (`ecr-auth.ts`).
5. Program **Caddy** through its admin API (`caddy.ts`; routes built in `routes.ts`) for
   domain → container HTTPS, with write-on-change reloads.
6. Write `status.json` + heartbeat (`status.ts`, `status-write.ts`).

The agent is **idempotent and crash-safe**: running it twice against the same desired state
is a no-op; per-action errors are isolated and the next tick retries from scratch. Local
port allocation (host ports 20000–30000, hashed per service+replica) persists in
`/var/lib/launch-pad/state.json` with atomic renames, so it self-heals across reboots.

## Zero-downtime rollouts

`rolloutService` surges a new replica (pull → run → wait for consecutive health-check
passes), refreshes routing **mid-rollout** (Caddy routes locally; upstream shards re-published
for remote edges at every surge/drain step), then drains the old replica — removed from
routing, drain wait floored at the edge's poll cadence, graceful `SIGTERM` stop. Caddy is
tuned for the handoff: retries, passive failure eviction, and active health probes.

## Edge routing

- **Co-located** (`both`-role, or `edge: null`): the local Caddy routes straight to local
  containers.
- **Split topology:** an `app` agent publishes an *upstream shard* (its private IP + backend
  list) into its edge's `upstream/` S3 prefix; the `edge` agent polls only its own
  `upstream/*` and reloads Caddy. No node ever reads another node's desired/status —
  enforced by per-node least-privilege IAM. Edge/both nodes reuse a per-tick shard-list
  cache (LIST ETags) to skip redundant GETs.

## Status publishing & heartbeats

The agent reconciles every tick but only PUTs `status.json`/shards when their *meaningful*
content changes — a fingerprint strips timestamp-only fields. Between changes it still
re-publishes every `LIVENESS_HEARTBEAT_MS` (30s) as a liveness heartbeat so the CLI's
staleness check (60s) stays reliable; mid-rollout and error paths always write.
`LAUNCHPAD_DEBUG_S3=1` logs written-vs-skipped PUTs per tick.

## Secrets, volumes, logs, stats

- **Secrets** (`secrets.ts`): resolves registered keys from SSM Parameter Store at container
  start and merges with plain `env` (plain wins on collision).
- **Volumes** (`docker.ts` `volumeName`/`buildRunArgs`): mounts a service's declared
  `[[service.volumes]]` as docker named volumes (`launchpadvol_<project>_<service>_<name>`,
  index-independent so the data is re-mounted across rollouts). A `docker rm` leaves the
  named volume intact, so the data outlives a container replacement. Deploy refuses to
  schedule a volume-bearing service onto a legacy rust-agent node (see below).
- **Logs** (`cloudwatch-logs.ts`): reconciles the Amazon CloudWatch Agent config
  (write-on-change) so container stdout ships to per-service log groups; degraded-safe —
  logging failures never break reconciliation.
- **Stats** (`stats.ts`): samples host CPU/memory (`/proc`) and per-container usage,
  emitting `launchpad.stats` JSON lines (~60s) that reach CloudWatch via the system log
  group — the data behind `launch-pad node monitor`.

## Configuration (env vars)

| Variable | Purpose |
| -------- | ------- |
| `LAUNCHPAD_POLL_MS` | Poll interval (default 5000) |
| `LAUNCHPAD_LIVENESS_MS` | Liveness heartbeat cadence (default 30000, clamped ≤ half the stale window) |
| `LAUNCHPAD_STATS_INTERVAL_MS` | Stats sampling cadence |
| `LAUNCHPAD_ONCE` | Run a single tick and exit |
| `LAUNCHPAD_DEBUG_S3` | Log written-vs-skipped S3 PUTs |
| `LAUNCHPAD_CADDY_ADMIN` | Caddy admin API address (default localhost:2019) |
| `LAUNCHPAD_STATE` | State file path override |

Node identity (region, nodeId, clusterId, bucket, role) comes from the config file written
by cloud-init at provision time.

## Distribution

The agent is **not on npm**. It is bundled to one self-contained CJS file, uploaded to
`nodes/<id>/agent.cjs` in S3, fetched via presigned URL by cloud-init on full bootstrap (or
pre-baked into the [golden AMI](golden-ami.md)), and run under systemd via Node.js.
`launch-pad node upgrade-agent` publishes a fresh bundle and restarts agents via SSM.

Legacy nodes may still have `agentType: "rust"` in their registry entry from an earlier
release; `node upgrade-agent` migrates them to the TypeScript bundle.
