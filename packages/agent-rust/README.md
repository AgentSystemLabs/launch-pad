# launch-pad-agent (Rust spike)

A **parallel Rust rewrite** of the Launch Pad node agent (`packages/agent`, TypeScript),
built under strict TDD: the existing Vitest suite was ported to Rust test-first, then
implemented until green. **The production TS agent is untouched** — this crate is exploration
only.

The spike now spans the whole agent: the load-bearing pure logic (`planReconcile`, write-on-change
fingerprints, the rolling-update sequencer) is ported with byte-for-byte parity, **and** a
runnable `main.rs` poll loop wires it to real AWS S3/ECR, Docker, Caddy, and IMDS. Why a separate
binary: a single static executable removes the Node runtime from the node, lowers RSS, and speeds
cold start.

## Layout decision

Lives at `packages/agent-rust/` (sibling of `packages/agent/`). It has **no `package.json`**, so
pnpm's `packages/*` workspace glob ignores it — the JS workspace is undisturbed. Run it with cargo.

## Running

```bash
cd packages/agent-rust
cargo test                   # all 108 tests (offline — no AWS/Docker needed)
cargo test stats             # one module
cargo clippy --all-targets   # lint (clean)
cargo build --release        # optimized binary → target/release/launch-pad-agent
```

`Cargo.lock` is git-ignored for the spike; commit it once this becomes a shipped binary.

## Architecture (Rust specifics)

- **Sync main thread, async at the leaves.** The poll loop and the tested `apply_actions` /
  `rollout_service` are synchronous (unchanged from the offline-tested logic). The only async is
  the AWS SDK (S3/ECR), driven via `Handle::block_on` at each I/O leaf — calls are sequential,
  never nested, so no runtime re-entrancy.
- **Docker** is driven via `std::process::Command` (subprocess, like the TS `execa` calls).
- **Caddy admin / health probes / IMDS** are plain loopback/link-local HTTP via `ureq` (sync) —
  no TLS needed there; the AWS SDK brings its own TLS for S3/ECR.
- **Injected clocks.** Library functions that the TS calls `Date.now()` inside (`build_status`,
  `build_upstream_shards`, `wait_healthy`, the sampler) take time as a parameter / injected dep so
  they stay pure and deterministic; `main.rs` supplies the real `chrono` clock.

## Module map (TS source → Rust module)

| TS source | Rust module | what it holds |
|---|---|---|
| `agent/index.ts` | `main.rs` | poll loop, role split, env vars, signals, `AgentReconciler` |
| `agent/stats.ts` | `stats.rs` | parsers, CPU normalization, sampler (`StatsDeps`) |
| `agent/status-write.ts` | `status_write.rs` | fingerprints, write-on-change decision, liveness |
| `agent/reconcile.ts` | `reconcile.rs` | `plan_reconcile` + `apply_actions`/`rollout_service` (`Reconciler` trait) |
| `agent/routes.ts` | `routes.rs` | co-located + shard route building, domain merge |
| `agent/upstream.ts` | `upstream.rs` | upstream-shard building |
| `agent/caddy.ts` | `caddy.rs` | config builder + `apply_caddy` (admin POST) |
| `agent/cloudwatch-logs.ts` | `cloudwatch_logs.rs` | collect-list + write-on-change sync |
| `agent/status.ts` | `status.rs` | `build_status`, `heartbeat_status`, rollup |
| `agent/state.ts` | `state.rs` | port allocation + JSON persistence + file I/O |
| `agent/config.ts` | `config.rs` | `agent.json` schema + parse + `load_agent_config` |
| `agent/docker.ts` | `docker.rs` | `ManagedReplica`, inspect parse, subprocess ops |
| `agent/health.ts` | `health.rs` | `wait_healthy` loop + `probe_health` + ceiling math |
| `agent/ecr-auth.ts` | `ecr.rs` | token decode → `docker login` |
| `agent/metadata.ts` | `metadata.rs` | IMDSv2 private-IP fetch (cached) |
| `agent/aws.ts` | `aws.rs` | S3 + ECR client factory |
| `agent/edge.ts` | `main.rs` `edge_tick` | edge reconcile path |
| `shared/{logs,s3-keys,edge}.ts` | `logs.rs`, `s3.rs`, `edge.rs` | naming, key derivation, shard→backend helpers |
| `shared/{desired,status,health,constants}.ts` | `types.rs` | serde wire types, enums, constants |

## Phase checklist — all complete

- [x] **Phase 0** — scaffold
- [x] **Phase 1** — pure planners (stats, status_write, reconcile, routes, upstream, caddy, cloudwatch)
- [x] **Phase 2** — serde types mirroring `packages/shared` + parsing/back-compat tests
- [x] **Phase 3** — status + state builders
- [x] **Phase 4** — I/O adapter pure halves (s3 keys, docker-inspect parse, health math) + async clients
- [x] **Phase 5** — imperative `apply_actions` / `rollout_service` (`Reconciler` trait)
- [x] **Phase 6** — `main.rs` poll loop: role split, env vars, SIGTERM/SIGINT, write-on-change,
      upstream publish, CloudWatch sync, stats sampler, real S3/ECR/Docker/Caddy/IMDS wiring
- [x] **Phase 7** — release build (`strip` + `lto` + `codegen-units=1` + `panic=abort`); size reported

## Parity table — ported Vitest suites

All 69 ported cases (Phase 1 + shared `s3-keys`) pass verbatim.

| TS test file | Rust module | ported | passing |
|---|---|---|---|
| `agent/stats.test.ts` | `stats.rs` | 17 | 17 ✅ |
| `agent/status-write.test.ts` | `status_write.rs` | 21 | 21 ✅ |
| `agent/reconcile.test.ts` | `reconcile.rs` | 9 | 9 ✅ |
| `agent/routes.test.ts` | `routes.rs` | 3 | 3 ✅ |
| `agent/upstream.test.ts` | `upstream.rs` | 1 | 1 ✅ |
| `agent/caddy.test.ts` | `caddy.rs` | 5 | 5 ✅ |
| `agent/cloudwatch-logs.test.ts` | `cloudwatch_logs.rs` | 7 | 7 ✅ |
| `shared/s3-keys.test.ts` | `s3.rs` | 6 | 6 ✅ |
| **Ported total** | | **69** | **69 ✅** |

Plus **39 additional Rust tests** with no direct TS counterpart (golden-hash byte-parity ×2,
type parsing/back-compat ×9, config ×3, status ×5, state ×5, docker-inspect parse ×2, health
loop+ceiling ×4, edge helpers ×2, shard routes ×1, list-fingerprint ×1, imperative rollout ×4,
smoke ×1). **Total suite: 108, all passing.**

## Parity highlights

- **Byte-identical fingerprints.** `fingerprint_status` / `fingerprint_shard` produce the exact
  sha256 hex the TS agent does (golden hashes captured from `status-write.ts` via `tsx`). Achieved
  by serializing through `serde_json::Value` (BTreeMap-backed `Map` → sorted keys, reproducing the
  TS `canonical()` recursive key-sort) and `skip_serializing_if = Option::is_none` (reproducing
  `JSON.stringify` omitting `undefined`).
- **`plan_reconcile`** reproduces count-based convergence (post-rollout non-`0..N-1` indices read as
  converged) and the single-`rollout`-on-drift collapse.
- **`rollout_service`** preserves the zero-downtime call order: a surged replica is health-gated and
  added to Caddy *before* any old replica is drained/stopped (asserted as an exact event sequence).

## Binary size / dependency notes

- **Release binary: 8.0 MB** (stripped, LTO, `panic=abort`), native `aarch64-apple-darwin`.
  Most of the weight is the AWS SDK (`aws-sdk-s3`, `aws-sdk-ecr`, `aws-config`) + its rustls TLS
  stack; the launch-pad logic itself is small. A single self-contained executable — **no Node
  runtime on the node.**
- **RSS estimate (not measured here):** a Rust agent of this shape typically idles around
  ~5–15 MB RSS vs. the current Node agent's ~40–80 MB. Unverified — needs a real Linux node to
  confirm; this spike does not switch production.
- Dependencies: `serde`/`serde_json` (BTreeMap `Map` is load-bearing for fingerprint parity),
  `sha2`, `tokio` (AWS runtime + `block_on`), `aws-config`/`aws-sdk-s3`/`aws-sdk-ecr`, `ureq`
  (loopback HTTP), `base64` (ECR token), `signal-hook` (SIGTERM/SIGINT), `chrono` (ISO timestamps).

## Known gaps / caveats

- **The main loop compiles and is structurally faithful, but is UNVERIFIED against real
  infrastructure** — there is no AWS account / Docker daemon / EC2 IMDS in this environment to
  run it against. The pure logic is fully tested (108 tests); the I/O wiring is type-checked and
  clippy-clean but not exercised end-to-end. First real-node validation is the obvious next step.
- **Linux release binary not produced here.** `cargo build --release --target
  x86_64-unknown-linux-gnu` needs the target + a cross-linker; no native cross-linker is installed
  on this macOS. Docker *is* present, so the path is `cargo install cross && cross build --release
  --target x86_64-unknown-linux-gnu` (or build on a Linux runner). Native size (8 MB) is indicative.
- **Lenient parsing.** The shared Zod schemas are `.strict()` (reject unknown keys); the serde
  structs ignore unknown fields (more forward-compatible). `parse_desired_state` does enforce the
  `version` literal and required fields.
- **Sync stats sampler.** The sampler uses synchronous trait deps (subprocess + file reads); fine
  for the per-tick cadence.

## Next steps toward production adoption (out of scope here)

1. Validate the binary on a real Linux node (S3 round-trip, Docker reconcile, Caddy program, IMDS).
2. Cross-compile the Linux release (`cross` + Docker) and measure real binary size + RSS vs. Node.
3. Teach the CLI to optionally bundle/upload the Rust binary (`packages/cli/src/provision/
   agent-bundle.ts`) with an **opt-in per-node flag**, alongside a systemd unit — none of which is
   touched by this spike.
