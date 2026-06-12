# Codebase layout

A map of the repository — where each concern lives and where to look when changing
something. Written for both humans and AI agents getting oriented.

## Top level

```
launch-pad/
├── README.md                  # documentation directory (start here)
├── CLAUDE.md                  # contributor/AI rules: invariants, commands, gotchas
├── docs/                      # this documentation set + the north-star spec (overview.md)
├── packages/
│   ├── shared/                # the typed CLI ↔ agent contract (Zod schemas)
│   ├── cli/                   # the product: init/deploy/status/logs/secret/node/cluster
│   ├── agent-rust/            # the node reconciler (Rust; edge + app binaries)
│   └── dashboard/             # local web UI (Bun; excluded from pnpm workspace)
├── e2e/                       # real-AWS end-to-end harness (opt-in, costs money)
├── examples/                  # runnable example apps — one per feature combination
├── infra/packer/              # golden AMI Packer template + build manifest
├── scripts/                   # golden AMI build + manifest update scripts
├── pnpm-workspace.yaml        # workspace: packages/* (minus dashboard), examples/*, e2e
└── tsconfig.base.json         # strict + noUncheckedIndexedAccess + verbatimModuleSyntax
```

pnpm workspace, Node ≥ 24, pnpm 11. Build with tsup; test with Vitest (co-located
`*.test.ts`). No linter/formatter — match existing style.

## `packages/shared` — the contract (import-only source of truth)

Every shape crossing the CLI ↔ agent boundary is a Zod schema exported from `src/index.ts`.
Both sides import it so they cannot drift; a mismatch is a parse error, not a hung deploy.

| Module | Purpose |
| ------ | ------- |
| `config.ts` | `launch-pad.toml` schema (`ServiceDeclSchema`, `LaunchPadConfigSchema`) |
| `desired.ts` | `desired.json` — CLI → agent desired state; web ingress is `null` (worker) or `{ domain, edge }` with a required edge node id |
| `status.ts` | `status.json` — agent → CLI node/service/replica status |
| `registry.ts` | `node.json` — node identity, role, capacity |
| `cluster.ts` | `cluster.json` — cluster config, default edge |
| `s3-keys.ts` | **All** S3 key derivation (bucket name, node/cluster/upstream keys) |
| `edge.ts` | Upstream-shard routing types (edge config, backends) |
| `capacity.ts` | Admission check + instance sizing (1024 shares = 1 vCPU) |
| `merge.ts` | Ownership-aware desired-state merge (multi-project nodes) |
| `health.ts` | Health-check + rollout schemas, duration parsing |
| `config-lock.ts` | Post-first-deploy config baseline (cpu/memory/replicas/env/secrets/domain/domainPattern mutable; identity locked) |
| `secrets.ts` | SSM parameter path layout + key validation |
| `logs.ts` / `stats.ts` | CloudWatch log group/stream naming; `launchpad.stats` line schema |
| `node-names.ts` | Generated `<noun>-<verb>-<adverb>` node names (create/bootstrap/auto-add/scale-out) |
| `constants.ts` | `PROTOCOL_VERSION`, heartbeat cadences, host-port range, labels |
| `aws-tags.ts` | `launch-pad=true` resource tagging |

## `packages/cli` — the product surface (commander-based)

`src/index.ts` registers the commands; bins are `launch-pad` and `lpd`.

| Area | Purpose |
| ---- | ------- |
| `src/commands/init.ts` | Scaffold `launch-pad.toml` |
| `src/commands/deploy.ts` | The heart: build → ECR push → admission → merge → publish → watch |
| `src/commands/status.ts` / `logs.ts` | Convergence + CloudWatch log reading |
| `src/commands/secret/` | SSM Parameter Store secrets (set/list/rm) |
| `src/commands/node/` | create/list/show/destroy/pause/resume/resize/upgrade-agent/install-logging/reconcile/monitor |
| `src/commands/cluster/` | create/list/show/set-edge/use/current/pause/resume/destroy |
| `src/aws/` | Thin AWS SDK clients (ec2, ecr, iam, ssm, s3-state, sts via `context.ts`) — per-node least-privilege IAM lives in `iam.ts` |
| `src/provision/` | Node bootstrap: `user-data.ts` (role-specific cloud-init), `systemd-unit.ts`, `agent-bundle.ts` (Rust binary distribution), `golden-ami.ts` + committed role-keyed `golden-ami-manifest.json` |
| `src/deploy/` | Pure planners: `placement.ts` (scheduler: bin-pack replicas over the app pool), `provision-plan.ts` (edge + app-node provisioning plan), `watch.ts` (status polling), `deployed-footprint.ts`, `drift-plan.ts`/`drift-apply.ts` |
| `src/config/` | TOML load/parse + `local.ts` (`~/.launch-pad/config.toml` local prefs) |
| `src/cluster/` | Cluster resolution/banner |

## `packages/agent-rust` — the node reconciler

One Rust crate, two role-specific binaries (`src/bin/agent-edge.rs` routes Caddy from
upstream shards; `src/bin/agent-app.rs` reconciles Docker). `cargo test` covers the pure
planners; `pnpm build:agent` cross-compiles the linux binaries the CLI distributes. See
[agent.md](agent.md) for behavior.

| Module | Purpose |
| ------ | ------- |
| `reconcile.ts` | **Pure** `planReconcile` diff + rollout sequencing — the most-tested file |
| `docker.ts` | Container lifecycle + label-based inspection |
| `caddy.ts` / `routes.ts` | Caddy admin-API programming, route building, LB tuning |
| `upstream.ts` / `edge.ts` | Upstream shard publish (app) / consume (edge) |
| `status.ts` / `status-write.ts` | Status building + write-on-change fingerprints + heartbeats |
| `state.ts` | Persistent host-port allocation (atomic writes) |
| `secrets.ts` | SSM secret resolution at container start |
| `ecr-auth.ts` / `health.ts` | Cached ECR login; HTTP health probing |
| `cloudwatch-logs.ts` / `stats.ts` | Log-shipping config reconciliation; resource sampling |

## `packages/dashboard` — local web UI (WIP)

Bun + orbital-js app that drives the CLI as a subprocess (`src/lib/run-launch-pad.ts`),
pages in `src/pages/`, Playwright tests against a fake CLI in `tests/`. Excluded from the
pnpm workspace. See [dashboard.md](dashboard.md).

## `e2e/`, `examples/`, `infra/`, `scripts/`

- `e2e/src/run.ts` — orchestrator for the real-AWS lifecycle test ([testing.md](testing.md)).
- `examples/*` — each directory is a runnable app + `launch-pad.toml` demonstrating one
  feature combination; [`examples/README.md`](../examples/README.md) has the matrix.
- `infra/packer/golden-ami.pkr.hcl` + `scripts/build-golden-ami.sh` — the golden AMI
  pipeline ([golden-ami.md](golden-ami.md)).

## Where to change what

| You want to… | Look at |
| ------------ | ------- |
| Add/change a `launch-pad.toml` field | `shared/src/config.ts` (+ `config-lock.ts` if it should be locked) |
| Change what crosses the wire | `shared/src/desired.ts` / `status.ts` — **additive only**, bump `PROTOCOL_VERSION` on shape changes |
| Change container start/stop/rollout behavior | `agent-rust/src/reconcile.rs` (pure planner first), then `docker.rs` |
| Change HTTPS/routing behavior | `agent-rust/src/routes.rs` / `caddy.rs`; edge routing: `upstream.rs` + `cli/src/aws/iam.ts` |
| Change placement/scheduling | `cli/src/deploy/placement.ts` + `shared/src/capacity.ts` |
| Change node provisioning / first boot | `cli/src/provision/*` + `infra/packer/` |
| Add a CLI command | `cli/src/commands/` + register in `cli/src/index.ts`; update [cli.md](cli.md) |
| Change S3 paths | `shared/src/s3-keys.ts` (never derive keys elsewhere) |

Before non-trivial changes, read [`CLAUDE.md`](../CLAUDE.md) — it lists the cross-cutting
invariants (idempotent agent, push-based routing, immutable tags, additive schemas) that
must not break.
