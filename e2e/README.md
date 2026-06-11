# launch-pad end-to-end tests

**Real-AWS**, on-demand tests that provision infrastructure, exercise the product, and
tear everything down. They are **not** part of `pnpm test` — they cost real money (a few
cents) and take minutes — so they only run when you explicitly ask for them. Both drive the
**built** CLI exactly as a user would (`node packages/cli/dist/index.js …`).

| Harness | Command | Covers | ~Time |
| ------- | ------- | ------ | ----- |
| Full lifecycle (`src/run.ts`) | `pnpm e2e` | provision → HTTPS → secrets → logs → zero-downtime rollout → scale → pause/resume → destroy | 10–20 min |
| Scaling (`src/scale.ts`) | `pnpm e2e:scale` | provision a `both` node → deploy a worker → `scale` replicas 1→3 → `config set` env → scale 3→1 → destroy | ~8–12 min |
| Undeploy (`src/undeploy.ts`) | `pnpm e2e:undeploy` | provision a `both` node → deploy 2 workers → `undeploy --service` one → redeploy the trimmed TOML (lock must permit) → undeploy the whole footprint → fresh redeploy | ~8–12 min |
| Deploy changed (`src/deploy-changed.ts`) | `pnpm e2e:deploy-changed` | provision a `both` node → deploy a 2-service monorepo (api + worker, co-located) → a partial `scale worker` deploy PRESERVES the co-located `api` (sibling-drop regression) → edit only apps/worker → `deploy --changed <v1>` rolls just `worker`, leaves `api` untouched → `deploy --changed HEAD` is a clean no-op → destroy | ~10–14 min |
| Image redeploy (`src/deploy-image.ts`) | `pnpm e2e:deploy-image` | deploy worker (v1) → change content + deploy (v2) → `deploy --image <v1>` rolls back without building → repeat is an idempotent no-op | ~10–14 min |
| Rollback (`src/rollback.ts`) | `pnpm e2e:rollback` | deploy worker (v1) → change content + deploy (v2) → `rollback` auto-picks the previous build (v1) → `rollback --to <v2-tag>` rolls forward | ~10–14 min |
| DNS setup (`src/dns-setup.ts`) | `pnpm e2e:dns` | provision a `both` node → `dns setup` writes a DNS-only Route53 A record at its Elastic IP → `dns verify` resolves to it → re-run is a no-op → record removed on teardown (no deploy) | ~3–5 min |
| Empty-cluster bootstrap (`src/empty-cluster.ts`) | `pnpm e2e:empty-cluster` | create a cluster with NO nodes → `deploy --no-create` is refused → `deploy` auto-bootstraps a single `both` node (`app-1`) for a cluster-placed worker → second deploy is idempotent (no re-bootstrap) → destroy | ~8–12 min |
| Capacity auto-add (`src/auto-add-node.ts`) | `pnpm e2e:auto-add` | bootstrap one node for a cluster-placed worker (replicas=1) → `scale replicas 3` overflows it → deploy auto-adds a second node (`app-2`) and spreads 3 replicas across both → destroy | ~12–16 min |
| Setup wizard (`src/setup.ts`) | `pnpm e2e:setup` | `setup` (default cluster) ensures the state bucket, no local target → `setup --cluster <id>` saves the local target + cluster.json → `cluster show` resolves it → `cluster destroy` removes the cluster but KEEPS the shared bucket (no EC2/Docker) | ~1 min |
| Backup/restore (`src/backup.ts`) | `pnpm e2e:backup` | set up a cluster + plant a synthetic desired.json → `backup` captures both → delete both from S3 (disaster) → `restore` re-uploads byte-for-byte → cluster resolves again → destroy keeps the shared bucket (no EC2/Docker) | ~1 min |
| Cost (`src/cost.ts`) | `pnpm e2e:cost` | provision one `both` node → `cost` reports it with a positive EC2 estimate → `cost --budget 0` flags over-budget (non-zero exit) → `cost --budget 10000` is within budget → destroy (no deploy/Docker) | ~3 min |
| Deploy history (`src/history.ts`) | `pnpm e2e:history` | deploy worker (v1) → deploy (v2) → `history --json` shows 2 events, newest-first, each with image + converged + caller ARN | ~8–12 min |
| Node IAM cleanup (`src/node-iam.ts`) | `pnpm e2e:node-iam` | create a node → assert its IAM role + instance profile exist → `node destroy` → assert they're gone (no deploy) | ~3–5 min |

The scaling, undeploy, deploy-changed, image-redeploy, and rollback harnesses are deliberately
worker-only (no domain/cert/DNS/secrets) so they're fast and agent-agnostic. Scaling guards
`scale`/`config` and the config-lock relief that lets `replicas`/`env` change after the first
deploy; undeploy guards `launch-pad undeploy` and the baseline-trim relief that lets a service
be removed; deploy-changed guards `deploy --changed` (monorepo "deploy only what changed") **and
the partial-deploy upsert** that keeps a co-located sibling alive when one service is
(re)deployed; image-redeploy guards `deploy --image`, and rollback guards `launch-pad rollback`'s
auto-pick of the previous immutable ECR tag (and `--to`).

## What `pnpm e2e` (full lifecycle) verifies

1. Provisions an isolated cluster: one **edge** node (public, Caddy) + one **app**
   node (private, no public IP).
2. The app node is genuinely **private** (registry has no public IP); the edge has
   a stable **Elastic IP**.
3. Deploys v1 and confirms the service answers over **HTTPS on a real domain** with
   a valid Let's Encrypt certificate.
4. Sets a real **SSM SecureString** via `launch-pad secret set`, deploys it as an
   env var, asserts `desired.json` contains only SSM refs (no plaintext), rotates
   it, and rolls containers with `deploy --restart`.
5. **Scales** replicas 2→3 and back with `launch-pad scale`, then sets a non-secret env
   var with `launch-pad config set`, asserting the agent converges to each new state
   (the same flow `pnpm e2e:scale` covers in isolation).
6. Reads service **logs** via `launch-pad logs`.
7. Reads service **CPU/memory stats** via `launch-pad node monitor`.
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
- A **Route53 hosted zone** you control that is a suffix of the test domain. By
  default the test uses `e2e-test.launch-pad.agentsystem.dev`, which requires a
  hosted zone for `launch-pad.agentsystem.dev` (or any parent). The harness
  creates the subdomain A record and deletes it on teardown.

## Running

From the repo root:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e          # full lifecycle (needs a Route53 zone)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:scale        # scaling only (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:undeploy     # undeploy / service removal (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-changed # monorepo deploy --changed + sibling preservation (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:deploy-image # deploy --image rollback (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:rollback     # rollback auto-pick + --to (no domain/DNS needed)
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e:history      # deploy history events (no domain/DNS needed)
```

All scripts build the CLI first, then run the harness. `pnpm e2e:scale`, `pnpm e2e:undeploy`,
`pnpm e2e:deploy-image`, `pnpm e2e:rollback`, and `pnpm e2e:history` are worker-only, so they
need **no Route53 hosted zone** — only AWS credentials + Docker.

### Options (environment / flags)

| Variable / flag          | Default                                   | Meaning                                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `LAUNCHPAD_E2E=1`        | _(unset → skips)_                         | Required opt-in.                         |
| `LAUNCHPAD_E2E_REGION`   | `us-east-1`                               | AWS region to provision in.              |
| `LAUNCHPAD_E2E_DOMAIN`   | `e2e-test.launch-pad.agentsystem.dev`     | Test subdomain (must sit under a zone you own). |
| `--keep` / `LAUNCHPAD_E2E_KEEP=1` | _(off)_                          | Leave the cluster running after the run for inspection. |

Each run uses a unique cluster id (`e2e-<random>`) and an isolated
`LAUNCHPAD_HOME` temp dir, so it never touches your real `~/.launch-pad` config
or other clusters.

### Cleanup

Teardown runs automatically in a `finally` block even if an assertion fails. If
you passed `--keep` (or the process was killed mid-run), tear down manually — the
final log line prints the exact command, e.g.:

```bash
LAUNCHPAD_HOME=/tmp/launch-pad-home-XXXX launch-pad cluster destroy e2e-abc123 --yes
```

> `cluster destroy` removes everything it created: instances, Elastic IPs,
> security groups, per-node IAM roles + instance profiles, and all S3 state under
> the cluster prefix. (Single-node `node destroy` still leaves IAM in place for a
> same-name re-create; a full cluster teardown does not.)
