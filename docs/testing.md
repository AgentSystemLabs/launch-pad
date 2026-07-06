# Testing & processes

How the project is verified, from unit tests to a real-AWS end-to-end run, plus the
repeatable build processes that aren't (yet) wired into CI.

## Unit tests (Vitest)

Co-located `*.test.ts` files across all packages:

```bash
pnpm test                                                    # everything
pnpm --filter @agentsystemlabs/launch-pad-shared test        # one package
pnpm --filter @agentsystemlabs/launch-pad-shared test src/config.test.ts
pnpm --filter @agentsystemlabs/launch-pad-shared test -- -t "capacity"
```

**The pure planners are the heavily-tested seam.** Prefer adding logic to pure functions —
`reconcile.ts`/`planReconcile`, `placement.ts`, `provision-plan.ts`, `capacity.ts`,
`merge.ts`, `s3-keys.ts` — and testing those directly, rather than testing through
AWS/Docker side-effecting code.

**Build-ordering gotcha:** `pnpm typecheck` works on a clean tree (tsconfig `paths` map
shared to source), but **runtime** resolution — `pnpm dev`, built binaries, and cli/agent
**vitest** runs — goes through `node_modules` → `packages/shared/dist`. After editing
`shared`, rebuild it (`pnpm --filter @agentsystemlabs/launch-pad-shared build`) before
running cli/agent tests or they exercise stale shared code.

## End-to-end test (real AWS)

[`e2e/`](../e2e) provisions a **real** edge + private app node, deploys a real app over
HTTPS, and tears everything down. It costs real money (cents) and takes 10–20 minutes, so
it is **not** part of `pnpm test` — it runs only when explicitly opted in:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e
```

| Env / flag | Purpose |
| ---------- | ------- |
| `LAUNCHPAD_E2E=1` | Required opt-in |
| `LAUNCHPAD_E2E_REGION` | AWS region (default `us-east-1`) |
| `LAUNCHPAD_E2E_DOMAIN` | Test subdomain — must resolve to the edge for the cert step (the full-lifecycle harness points it via a hosted zone you own; every other e2e needs no DNS at all) |
| `--keep` / `LAUNCHPAD_E2E_KEEP=1` | Leave the cluster running for inspection |

What it verifies, in order: isolated cluster provisioning with a stable Elastic IP; the app
node is genuinely private; v1 deploy serves HTTPS on a real domain (Let's Encrypt); secrets
via `secret set` reach the container; `logs` and `node monitor` return data; a v2 deploy
rolls with **zero downtime** (continuous polling through the rollout); re-deploying the same
version is **idempotent** (no container churn); pause/resume recovers on the same Elastic
IP; destroy removes all S3 state. Teardown runs automatically; if interrupted, the manual
cleanup command is printed.

Two focused, **worker-only** harnesses (no domain/cert/DNS/secrets, so they're fast,
agent-agnostic, and need no DNS zone) guard the post-deploy mutation paths:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:scale         # scale replicas/cpu/memory + config set
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:destroy        # destroy a service / footprint + config-lock relief
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-changed # monorepo deploy --changed + co-located sibling preservation
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-image  # deploy --image rollback to an existing tag
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rollback      # rollback auto-picks the previous build (+ --to)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:remote-build  # deploy --remote-build builds on CodeBuild (local docker shimmed to fail)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:empty-cluster # ARM/T4G empty-cluster bootstrap + remote-build deploy
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:history       # deploy history events (who/when/image/converged)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:node-iam      # node destroy deletes the per-node IAM role/profile (no deploy)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:operator-iam  # the generated operator IAM policy is sufficient (and scoped)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rebalance     # rebalance + node evacuate move replicas across the app pool
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:destroy-evacuate # node destroy --evacuate auto-drains then tears down
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:resize-evacuate # node resize --evacuate drains, retypes, rebalances back
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:volumes       # persistent volume data survives a container replace
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:cron          # scheduled (cron) worker fires per minute, exit codes recorded
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:autoscale     # reactive autoscaling: live-CPU scale-out, drain-first scale-in
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:destroy-env    # named envs: deploy --env --ttl, --list-envs, TTL prune, --env destroy (zero DNS writes)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:idle          # cost flags an idle (paused) node (no deploy)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:alerts        # alerts check fires on a dead node (heartbeat-stale) + webhook
```

`e2e:empty-cluster` is the Graviton bootstrap verifier. It uses a random named cluster
and temporary `LAUNCHPAD_HOME` (never `default`), deploys the worker fixture with
`--remote-build` into an empty cluster, and asserts the auto-created edge is
`t4g.nano`/`arm64`, the generated app node is `t4g.micro`/`arm64`, both agents publish
status, the worker reaches `running`, and a second deploy is idempotent. Teardown destroys
the named cluster unless `--keep` /
`LAUNCHPAD_E2E_KEEP=1` is set.

`e2e:alerts` deploys a worker (node healthy), asserts `alerts check` is clean, then **terminates
the EC2 instance out-of-band** so the registry still says the node is up while the agent stops
heartbeating — then asserts `alerts check` fires `heartbeat-stale`, POSTs a local webhook
receiver, and exits non-zero.

`e2e:volumes` deploys a
worker with a `/data` volume that appends a boot line on every container start, then
`deploy --restart`s to replace the container and asserts (via `launchpad logs`) the boot count
went 1 → 2 — the same volume was re-mounted, so the data survived the replace. It also confirms
the config lock refuses a post-deploy volume-path change.

`e2e:cron` deploys a `cron = "* * * * *"` worker
(`examples/cron-task` — prints a line and exits 0). It asserts the deploy converges even
though a cron service keeps **zero** long-running replicas, that the first fire is recorded in
the status `cron` rollup (`lastRunAt` set, `lastExitCode` 0, `nextRunAt` scheduled), that a
**second** fire advances `lastRunAt` (periodic, not one-shot), that the config lock refuses a
post-deploy cron-expression change, and that `destroy` removes the job from the node.

One-off jobs are verified through focused unit tests plus the live
[`examples/postgres-api-task`](../examples/postgres-api-task) flow: deploy the managed
Postgres service, run `launchpad job run migrate --wait`, then deploy the API and assert
`/db` returns the migration row over HTTPS.

`e2e:autoscale` deploys a BURN-toggled worker (its env flips it between idling and holding
~1.3 GB of memory — `env` is operationally mutable, so `config set` re-rolls it; memory rather
than CPU drives the trigger because a fresh t3 in standard credit mode throttles a busy loop
to its ~20%/vCPU baseline) and drives the whole policy lifecycle against **live host
metrics**: a no-op while idle, a real scale-out once the hot sample crosses the threshold (the new `app-2` is provisioned and later proven to
run replicas via `scale replicas 2`), a hold at `maxNodes`, then a scale-in that drains `app-2`
— asserting both replicas are running on `app-1` **after** the command returns (the drain waited
before terminating) — and a final hold at `minNodes`.

`e2e:rebalance` provisions one edge + two app nodes, deploys an auto-placed worker at
`replicas = 3` (2+1), evacuates one node (replicas consolidate onto the other), `rebalance`s
back (they spread again), proves a second rebalance is a no-op, then evacuates +
`node destroy`s a node (which succeeds because nothing is scheduled there) and checks a
**volume-bearing** service's node can't be evacuated (sticky placement).

`e2e:destroy-evacuate` provisions the same edge + two-app-node / 3-replica-worker layout, then proves
the one-shot `node destroy --evacuate`: it first asserts a plain `node destroy` **refuses** to
orphan the replica, then `node destroy <b> --evacuate` moves that replica onto the surviving node,
**waits** for it to be running there (so the node already shows all 3 when the command returns),
and tears `<b>` down — confirming its registry entry is gone. Finally it asserts `node destroy <a>
--evacuate` **refuses** when `<a>` is the last app node (nowhere to move the replicas), leaving it
intact.

`e2e:resize-evacuate` provisions the same edge + two-app-node / 3-replica-worker layout, then proves
the non-disruptive vertical scale: `node resize <b> --instance-type t3.medium --evacuate` first
drains `<b>`'s replica onto `<a>` and waits (the harness polls **while the command is in
flight** and observes all 3 replicas running on `<a>` before `<b>`'s instance stops), retypes
the emptied instance, then rebalances back — the even 2+1 spread and the new instance
type/capacity are asserted when the command returns. It also checks the `--evacuate --dry-run`
plan changes nothing and that `--evacuate` **refuses** a paused node.

`e2e:deploy-changed` deploys a 2-service monorepo (api + worker co-located on one app node),
then (1) runs a partial `scale worker` deploy and asserts the co-located `api` container is
**preserved byte-for-byte** — the regression guard for the subset-merge that used to drop a
sibling — then (2) edits only `apps/worker`, runs `deploy --changed <v1>`, and asserts only
`worker` rebuilds/rolls while `api`'s container and published image are untouched, and finally
(3) asserts `deploy --changed HEAD` with nothing changed is a clean no-op that rolls nothing.

`e2e:destroy` deploys two workers, removes one with `destroy --service`, proves a redeploy of
the trimmed `launch-pad.toml` passes the config lock, then removes the whole footprint and
re-deploys it fresh. `e2e:deploy-image` deploys v1, changes content and deploys v2, then
`deploy --image <v1-uri>` rolls back to v1 **without rebuilding** (and a repeat is a no-op).
`e2e:remote-build` proves `deploy --remote-build` end-to-end with **local docker shimmed to a
failing stub on PATH** for every CLI invocation: the v1 deploy builds + pushes on CodeBuild and
converges, the per-cluster CodeBuild project exists with privileged docker + `NO_SOURCE`, an
unchanged re-deploy skips the build (image already in ECR, no container churn), a content
change builds a new immutable image remotely and rolls the container, and `cluster destroy`
removes the CodeBuild project + service role along with everything else.
`e2e:operator-iam` is the strongest proof the `setup iam-policy` output is correct: it mints a
temporary IAM user with **only** the generated policy, then runs a full provision → deploy →
destroy under that user's credentials (so a missing permission fails the matching
step), plus negative checks that the policy can't act outside its scope or region and an IAM
Access Analyzer `validate-policy` pass. The admin identity is fully stripped from the scoped
subprocess (`makeCli({ clearAwsEnv: true })`) so the assertions can't silently run under admin
power. See [e2e/README.md](../e2e/README.md) for the full matrix.

## Dashboard tests

Playwright e2e against a fake CLI — see [dashboard.md](dashboard.md#testing).

## Agent (Rust) tests

`pnpm test:agent` (= `cargo test` in `packages/agent-rust`) runs the agent's unit suite —
the pure planners (reconcile, cron, fingerprints with golden hashes, Caddy config +
restart detection) ported from the retired TypeScript agent's Vitest suite. `pnpm test`
stays TS-only so contributors without a Rust toolchain aren't blocked.

## Golden AMI build

`pnpm build:golden-ami` cross-compiles the Rust agent binaries for both supported
architectures and bakes role + architecture-specific AMIs (edge/app × x86_64/arm64) with
Packer, updating the committed manifest the CLI reads. Run it when the agent or baked
dependencies change. Details: [golden-ami.md](golden-ami.md).

## CI status

One GitHub Actions workflow is checked in:

- `.github/workflows/release.yml` publishes the `@agentsystemlabs/launch-pad` CLI to npm via
  OIDC Trusted Publishing on a `v*` tag (typecheck + test gate the publish). See
  [releasing.md](releasing.md).

Broader repo gates are still local for now: `pnpm typecheck`, `pnpm test`, the e2e harness,
and golden AMI builds are run via the commands above. Future CI should add `pnpm typecheck` +
`pnpm test` on every push, with the e2e harness and AMI build as manually-triggered jobs
(they need real AWS credentials and spend).

## Other conventions

- **No linter/formatter is configured** — match existing style by hand. tsconfig is
  `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
- [`examples/web-worker`](../examples/web-worker) is the end-to-end
  fixture every feature is validated against (a tiny Express app that handles `SIGTERM` for
  graceful drain).
