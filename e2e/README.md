# launchpad end-to-end tests

**Real-AWS**, on-demand tests that provision infrastructure, exercise the product, and
tear everything down. They are **not** part of `pnpm test` — they cost real money (a few
cents) and take minutes — so they only run when you explicitly ask for them. Both drive the
**built** CLI exactly as a user would (`node packages/cli/dist/index.js …`).

| Harness | Command | Covers | ~Time |
| ------- | ------- | ------ | ----- |
| Full lifecycle (`src/run.ts`) | `pnpm e2e` | provision → HTTPS → secrets → logs → zero-downtime rollout → scale → pause/resume → destroy | 10–20 min |
| Scaling (`src/scale.ts`) | `pnpm e2e:scale` | provision an edge + app node pair → deploy a worker → `scale` replicas 1→3 → `config set` env → scale 3→1 → destroy | ~8–12 min |
| Destroy (`src/destroy.ts`) | `pnpm e2e:destroy` | provision an edge + app node pair → deploy 2 workers → `destroy --service` one → redeploy the trimmed TOML (lock must permit) → destroy the whole footprint → fresh redeploy | ~8–12 min |
| Deploy changed (`src/deploy-changed.ts`) | `pnpm e2e:deploy-changed` | provision an edge + app node pair → deploy a 2-service monorepo (api + worker, sharing the app node) → a partial `scale worker` deploy PRESERVES the co-located `api` (sibling-drop regression) → edit only apps/worker → `deploy --changed <v1>` rolls just `worker`, leaves `api` untouched → `deploy --changed HEAD` is a clean no-op → destroy | ~10–14 min |
| Image redeploy (`src/deploy-image.ts`) | `pnpm e2e:deploy-image` | deploy worker (v1) → change content + deploy (v2) → `deploy --image <v1>` rolls back without building → repeat is an idempotent no-op | ~10–14 min |
| Remote build (`src/remote-build.ts`) | `pnpm e2e:remote-build` | provision an edge + app node pair → `deploy --remote-build` with local docker SHIMMED TO FAIL (v1 builds on CodeBuild + converges) → CodeBuild project exists (privileged, NO_SOURCE) → unchanged re-deploy skips the build → content change builds v2 remotely and rolls → destroy removes the CodeBuild project + role | ~12–16 min |
| Rollback (`src/rollback.ts`) | `pnpm e2e:rollback` | deploy worker (v1) → change content + deploy (v2) → `rollback` auto-picks the previous build (v1) → `rollback --to <v2-tag>` rolls forward | ~10–14 min |
| Empty-cluster bootstrap (`src/empty-cluster.ts`) | `pnpm e2e:empty-cluster` | create a cluster with NO nodes → `deploy --no-create` is refused → `deploy` auto-bootstraps the minimum topology (`edge-1` + `app-1`) for an auto-placed worker → second deploy is idempotent (no re-bootstrap) → destroy | ~8–12 min |
| Capacity auto-add (`src/auto-add-node.ts`) | `pnpm e2e:auto-add` | bootstrap `edge-1` + `app-1` for an auto-placed worker (replicas=1) → `scale replicas 3` overflows app-1 → deploy auto-adds a second app node (`app-2`) and spreads 3 replicas across both → destroy | ~12–16 min |
| Setup wizard (`src/setup.ts`) | `pnpm e2e:setup` | `setup` (default cluster) ensures the state bucket, no local target → `setup --cluster <id>` saves the local target + cluster.json → `cluster show` resolves it → `cluster destroy` removes the cluster but KEEPS the shared bucket (no EC2/Docker) | ~1 min |
| Backup/restore (`src/backup.ts`) | `pnpm e2e:backup` | set up a cluster + plant a synthetic desired.json → `backup` captures both → delete both from S3 (disaster) → `restore` re-uploads byte-for-byte → cluster resolves again → destroy keeps the shared bucket (no EC2/Docker) | ~1 min |
| Cost (`src/cost.ts`) | `pnpm e2e:cost` | provision one edge node → `cost` reports it with a positive EC2 estimate → `cost --budget 0` flags over-budget (non-zero exit) → `cost --budget 10000` is within budget → destroy (no deploy/Docker) | ~3 min |
| Deploy history (`src/history.ts`) | `pnpm e2e:history` | deploy worker (v1) → deploy (v2) → `history --json` shows 2 events, newest-first, each with image + converged + caller ARN | ~8–12 min |
| Node IAM cleanup (`src/node-iam.ts`) | `pnpm e2e:node-iam` | create a node → assert its IAM role + instance profile exist → `node destroy` → assert they're gone (no deploy) | ~3–5 min |
| Cron jobs (`src/cron.ts`) | `pnpm e2e:cron` | provision an edge + app node pair → deploy a `cron = "* * * * *"` worker (runs once per fire, exits 0) → deploy converges at 0 running replicas → first fire recorded (`cron.lastRunAt` + exit 0) → second fire ADVANCES `lastRunAt` (periodic) → config lock refuses a cadence change → `destroy` removes the job → teardown | ~10–14 min |
| Autoscale (`src/autoscale.ts`) | `pnpm e2e:autoscale` | bootstrap `edge-1` + `app-1` via deploy (BURN-toggled worker: BURN=1 holds ~1.3 GB — memory, not CPU, because t3 credit throttling caps a busy loop below any workable threshold) → save a 25/10 policy → `autoscale run` is a no-op while idle → `config set BURN=1` heats the node → `run` provisions the `app-2` app node → second `run` holds at maxNodes → BURN=0 + `scale replicas 2` spreads 1+1 onto the new node → 90/60 policy → `run` drains the least-utilized app node (replica moves to the survivor BEFORE teardown; the edge is never a candidate) and terminates it → final `run` holds at minNodes → destroy | ~20–25 min |
| Named envs (`src/destroy-env.ts`) | `pnpm e2e:destroy-env` | provision an edge + app node pair → `deploy --env pr-a --ttl 1m` converges with ZERO DNS writes (the deploy reports each projected domain's A-record target; DNS is user-managed) → `deploy --env pr-b` (no TTL) → `destroy --list-envs` shows both with expiry metadata → `--prune-expired --json` without `--yes` is refused → after the TTL lapses `destroy --prune-expired --yes` destroys ONLY pr-a (containers stopped, marker swept; pr-b untouched) → `destroy --env pr-b` tears down the survivor → final prune pass is a clean no-op → teardown | ~12–16 min |
| Components (`src/components.ts`) | `pnpm e2e:components` | provision an edge + app node pair → deploy component `auth` from its own repo (`project = "fed"`, `component = "auth"` → owner `fed--auth`) → a FULL deploy of sibling component `notes` from a second repo PRESERVES auth's container (different replace key — the federation guarantee) → `project show fed --json` aggregates both components from the registry → a third repo reusing service name `auth` is refused pre-build (cross-component uniqueness) → `destroy` from the auth repo removes only auth → `destroy --project fed --yes` (TOML-less) tears down the rest + the registry → teardown | ~10–14 min |
| Resize evacuate (`src/resize-evacuate.ts`) | `pnpm e2e:resize-evacuate` | one edge + two app nodes + auto-placed worker (3 replicas, bin-packed → 2+1) → `node resize <b> --evacuate` drains the replica to `<a>` (observed running there mid-command), retypes `<b>` to t3.medium, rebalances back (2+1 restored) → refuses `--evacuate` on a paused node | ~15–20 min |

The scaling, destroy, deploy-changed, image-redeploy, remote-build, and rollback harnesses are
deliberately worker-only (no domain/cert/DNS/secrets) so they're fast. Scaling
guards `scale`/`config` and the config-lock relief that lets `replicas`/`env` change after the
first deploy; destroy guards `launchpad destroy` and the baseline-trim relief that lets a
service be removed; deploy-changed guards `deploy --changed` (monorepo "deploy only what changed")
**and the partial-deploy upsert** that keeps a co-located sibling alive when one service is
(re)deployed; image-redeploy guards `deploy --image`; remote-build guards `deploy --remote-build`
(CodeBuild builds with no local docker — the shim makes any local docker call a hard failure);
and rollback guards `launchpad rollback`'s auto-pick of the previous immutable ECR tag (and
`--to`).

## What `pnpm e2e` (full lifecycle) verifies

1. Provisions an isolated cluster: one **edge** node (public, Caddy) + one **app**
   node (private, no public IP).
2. The app node is genuinely **private** (registry has no public IP); the edge has
   a stable **Elastic IP**.
3. Deploys v1 and confirms the service answers over **HTTPS on a real domain** with
   a valid Let's Encrypt certificate.
4. Sets a real **SSM SecureString** via `launchpad secret set`, deploys it as an
   env var, asserts `desired.json` contains only SSM refs (no plaintext), rotates
   it, and rolls containers with `deploy --restart`.
5. **Scales** replicas 2→3 and back with `launchpad scale`, then sets a non-secret env
   var with `launchpad config set`, asserting the agent converges to each new state
   (the same flow `pnpm e2e:scale` covers in isolation).
6. Reads service **logs** via `launchpad logs`.
7. Reads service **CPU/memory stats** via `launchpad node monitor`.
8. Deploys v2 (a real source change → new image) and asserts the live response
   flips v1 → v2 **with zero downtime** (continuous polling during the rollout).
9. Re-deploys the same version and asserts it is **idempotent** (no container churn).
10. **Pauses** the whole group (`cluster pause`) — both instances stop.
11. **Resumes** the group and confirms the service recovers on the same Elastic IP.
12. **Destroys** the whole group (`cluster destroy`) and confirms all S3 state is
    gone and the CLI no longer shows the cluster.

## Prerequisites

- **AWS credentials** in your environment (e.g. `AWS_PROFILE=…`, or access keys).
  The harness uses your default credential chain.
- **Docker** running locally (the CLI builds the image with `docker buildx`).
- **Agent binaries built** — `pnpm build:agent` (Rust toolchain + `cargo-zigbuild`
  off-Linux). Every provision/upgrade uploads the linux binaries from
  `packages/agent-rust/dist/`; the CLI errors with this exact hint if they're missing.
- **Full lifecycle (`pnpm e2e`) only:** the test domain must resolve to the
  freshly-provisioned edge so Let's Encrypt can issue. Launch Pad itself never
  writes DNS (it's user-managed — a wildcard at a stable edge EIP suffices in
  real use), but each e2e run allocates a NEW edge EIP, so the harness plays the
  "user points DNS" step itself via a Route53 hosted zone you control that is a
  suffix of the test domain (default `e2e-test.launch-pad.agentsystem.dev` →
  a zone for `launch-pad.agentsystem.dev` or any parent). The record is created
  by the harness and deleted on teardown. Every other e2e needs no DNS at all.

## Running

From the repo root:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e          # full lifecycle (needs the harness DNS zone — see Prerequisites)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:scale        # scaling only (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:destroy       # destroy / service removal (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-changed # monorepo deploy --changed + sibling preservation (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-image # deploy --image rollback (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rollback     # rollback auto-pick + --to (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:history      # deploy history events (no domain/DNS needed)
```

All scripts build the CLI first, then run the harness. `pnpm e2e:scale`, `pnpm e2e:destroy`,
`pnpm e2e:deploy-image`, `pnpm e2e:rollback`, and `pnpm e2e:history` are worker-only, so they
need **no DNS zone** — only AWS credentials + Docker.

### Options (environment / flags)

| Variable / flag          | Default                                   | Meaning                                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `LAUNCHPAD_E2E=1`        | _(unset → skips)_                         | Required opt-in.                         |
| `LAUNCHPAD_E2E_REGION`   | `us-east-1`                               | AWS region to provision in.              |
| `LAUNCHPAD_E2E_DOMAIN`   | `e2e-test.launch-pad.agentsystem.dev`     | Test subdomain — must be resolvable to the edge; for `pnpm e2e` the harness points it via a hosted zone you own. |
| `--keep` / `LAUNCHPAD_E2E_KEEP=1` | _(off)_                          | Leave the cluster running after the run for inspection. |

Each run uses a unique cluster id (`e2e-<random>`) and an isolated
`LAUNCHPAD_HOME` temp dir, so it never touches your real `~/.launch-pad` config
or other clusters.

### Cleanup

Teardown runs automatically in a `finally` block even if an assertion fails. If
you passed `--keep` (or the process was killed mid-run), tear down manually — the
final log line prints the exact command, e.g.:

```bash
LAUNCHPAD_HOME=/tmp/launch-pad-home-XXXX launchpad cluster destroy e2e-abc123 --yes
```

> `cluster destroy` removes everything it created: instances, Elastic IPs,
> security groups, per-node IAM roles + instance profiles, and all S3 state under
> the cluster prefix. (Single-node `node destroy` still leaves IAM in place for a
> same-name re-create; a full cluster teardown does not.)
