# launch-pad-agent (Rust)

**The** Launch Pad node agent — one crate, two role-specific binaries:

| Binary | Feature | Runs on | Does |
| ------ | ------- | ------- | ---- |
| `launchpad-agent-edge` | `edge` | the cluster's dedicated edge node | reads its own S3 `upstream/*` shards → programs **Caddy** via the admin API (`POST /load`, with live-config probing so a Caddy restart is re-pushed within one tick), publishes `status.json` + heartbeats, samples host stats. **No Docker / ECR / SSM code or deps compiled in.** |
| `launchpad-agent-app` | `app` | every app node | polls `desired.json` → reconciles **Docker** (pure `plan_reconcile` planner, health-gated rolling rollouts, cron scheduled jobs, persistent volumes, SSM secret resolution), publishes upstream shards for the edge, `status.json` (write-on-change + liveness heartbeat with the embedded host sample), CloudWatch Agent config sync, host + per-container stats. |

Both binaries fail closed at startup if the node's `/etc/launch-pad/agent.json` role
doesn't match the binary, and the app binary refuses to run without Docker.

The crate is a behavior-parity port of the retired TypeScript agent
(`packages/agent`, removed) — module-for-module against `packages/shared`'s Zod
contracts, including byte-identical status/shard fingerprints and `configStamp`
labels so a live node can migrate TS → Rust without rolling its containers.

## Building

```bash
cargo test                # all modules (default features = edge + app)
pnpm build:agent          # → dist/{x86_64,arm64}/agent-edge + agent-app
                          #   static musl release builds
                          #   (cargo-zigbuild + zig on non-Linux hosts)
```

The CLI resolves `dist/<arch>/agent-<role>` through this package's npm name
(`@agentsystemlabs/launch-pad-agent`) when it uploads the binary at
provision/upgrade time; the golden AMI builds bake the same files.

`Cargo.lock` is committed — the binaries are a distributed artifact and fresh
dependency resolution has broken the build before (`time` 0.3.48 ×
`aws-smithy-types`, `aws-smithy-eventstream` 0.60.21 × `aws-runtime`); the lock
pins known-good versions.

## Layout

Shared modules (both roles): `types` (wire contracts + `service_config_stamp`),
`config`, `cron` (5-field UTC evaluator), `s3` (keys + client + shard-list ETag
cache), `status`, `status_write` (fingerprints + liveness), `stats`, `cloudwatch_logs`,
`logs`, `runtime`, `docker` (types/parsers; std-only).

App-only: `reconcile` (planner + rollout state machine), `ecr`, `secrets`, `health`,
`metadata` (IMDS), `state` (ports + cron fires), `upstream`.

Edge-only: `caddy` (config builder + restart-detecting apply), `routes`, `edge`.
