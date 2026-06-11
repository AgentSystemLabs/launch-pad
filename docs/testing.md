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
| `LAUNCHPAD_E2E_DOMAIN` | Test subdomain — must live under a **Route53 hosted zone you own** |
| `--keep` / `LAUNCHPAD_E2E_KEEP=1` | Leave the cluster running for inspection |

What it verifies, in order: isolated cluster provisioning with a stable Elastic IP; the app
node is genuinely private; v1 deploy serves HTTPS on a real domain (Let's Encrypt); secrets
via `secret set` reach the container; `logs` and `node monitor` return data; a v2 deploy
rolls with **zero downtime** (continuous polling through the rollout); re-deploying the same
version is **idempotent** (no container churn); pause/resume recovers on the same Elastic
IP; destroy removes all S3 state. Teardown runs automatically; if interrupted, the manual
cleanup command is printed.

Two focused, **worker-only** harnesses (no domain/cert/DNS/secrets, so they're fast,
agent-agnostic, and need no Route53 zone) guard the post-deploy mutation paths:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:scale         # scale replicas/cpu/memory + config set
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:undeploy      # undeploy a service / footprint + config-lock relief
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-image  # deploy --image rollback to an existing tag
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rollback      # rollback auto-picks the previous build (+ --to)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:history       # deploy history events (who/when/image/converged)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:node-iam      # node destroy deletes the per-node IAM role/profile (no deploy)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:operator-iam  # the generated operator IAM policy is sufficient (and scoped)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rebalance     # rebalance + node evacuate move cluster-placed replicas
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:volumes       # persistent volume data survives a container replace
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:idle          # cost flags an idle (paused) node (no deploy)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:alerts        # alerts check fires on a dead node (heartbeat-stale) + webhook
```

`e2e:alerts` deploys a worker (node healthy), asserts `alerts check` is clean, then **terminates
the EC2 instance out-of-band** so the registry still says the node is up while the agent stops
heartbeating — then asserts `alerts check` fires `heartbeat-stale`, POSTs a local webhook
receiver, and exits non-zero.

`e2e:volumes` provisions one `both` node, deploys a
worker pinned to it with a `/data` volume that appends a boot line on every container start, then
`deploy --restart`s to replace the container and asserts (via `launch-pad logs`) the boot count
went 1 → 2 — the same volume was re-mounted, so the data survived the replace. It also confirms
the config lock refuses a post-deploy volume-path change.

`e2e:rebalance` provisions two `both` nodes, deploys a cluster-placed worker at `replicas = 3`
(even → 2+1), evacuates one node (replicas consolidate onto the other), `rebalance`s back (they
spread again), proves a second rebalance is a no-op, then evacuates + `node destroy`s a node
(which succeeds because nothing is scheduled there) and checks a **pinned** service can't be
evacuated.

`e2e:undeploy` deploys two workers, removes one with `undeploy --service`, proves a redeploy of
the trimmed `launch-pad.toml` passes the config lock, then removes the whole footprint and
re-deploys it fresh. `e2e:deploy-image` deploys v1, changes content and deploys v2, then
`deploy --image <v1-uri>` rolls back to v1 **without rebuilding** (and a repeat is a no-op).
`e2e:operator-iam` is the strongest proof the `setup iam-policy` output is correct: it mints a
temporary IAM user with **only** the generated policy, then runs a full provision → deploy →
undeploy → destroy under that user's credentials (so a missing permission fails the matching
step), plus negative checks that the policy can't act outside its scope or region and an IAM
Access Analyzer `validate-policy` pass. The admin identity is fully stripped from the scoped
subprocess (`makeCli({ clearAwsEnv: true })`) so the assertions can't silently run under admin
power. See [e2e/README.md](../e2e/README.md) for the full matrix.

## Dashboard tests

Playwright e2e against a fake CLI — see [dashboard.md](dashboard.md#testing).

## Golden AMI build

`pnpm build:golden-ami` cross-compiles the Rust agent and bakes a new AMI with Packer,
updating the committed manifest the CLI reads. Run it when the agent or baked dependencies
change. Details: [golden-ami.md](golden-ami.md).

## CI status

There are **no GitHub Actions workflows yet** — typecheck, unit tests, the e2e run, and
golden AMI builds are all run locally via the commands above. When CI lands, the intended
gates are `pnpm typecheck` + `pnpm test` on every push, with the e2e harness and AMI build
as manually-triggered jobs (they need real AWS credentials and spend).

## Other conventions

- **No linter/formatter is configured** — match existing style by hand. tsconfig is
  `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
- [`examples/both-node-web-worker`](../examples/both-node-web-worker) is the end-to-end
  fixture every feature is validated against (a tiny Express app that handles `SIGTERM` for
  graceful drain).
