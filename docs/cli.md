# CLI reference

Install/run via npx (no global install required). Three bins are registered: `launchpad`,
`launch-pad`, and the short alias `lpd`.

```bash
npx @agentsystemlabs/launch-pad <command>
```

Commands: [`init`](#init) · [`doctor`](#doctor) · [`deploy`](#deploy) · [`destroy`](#destroy) ·
[`scale`](#scale) · [`config`](#config) · [`status`](#status) · [`logs`](#logs) · [`job`](#job) ·
[`secret`](#secret) · [`dns`](#dns) · [`node`](#node) · [`project`](#project) · [`cluster`](#cluster)

## Global options

Available on every command (before or after the subcommand):

| Flag | Description |
| ---- | ----------- |
| `--profile <name>` | AWS profile to use |
| `--region <region>` | AWS region (defaults to AWS config) |
| `--cluster <name>` | Target cluster (default: your local default cluster, else `default`) |
| `--json` | Machine-readable JSON (no banner/spinners) |
| `--verbose` | Verbose output; stack traces on error |
| `--no-color` | Disable colored output |
| `-V, --version` | Print version |
| `-h, --help` | Command help |

AWS-touching commands print a `cluster: <id>` banner so you always know which cluster a
command targets.

In `--json` mode a failing command emits `{"error": "...", "hint": "..."}` to **stdout**
(plus the non-zero exit code) — human-readable stderr logging is suppressed, so this is
the only way automation sees *why* a command failed.

---

## `init`

Create a `launch-pad.toml` in the current directory.

```bash
launchpad init [options]
```

| Flag | Description |
| ---- | ----------- |
| `--name <name>` | Project and service name |
| `--domain <domain>` | Public domain (makes this a web service) |
| `--port <port>` | Container port |
| `--dockerfile <path>` | Path to Dockerfile (default `./Dockerfile`) |
| `--cpu <shares>` | CPU in vCPU shares (1024 = 1 vCPU) |
| `--memory <mb>` | Memory in MB |
| `-f, --force` | Overwrite an existing config |

Run interactively, `init` **detects your project** to seed smarter defaults: it reads the
Dockerfile's `EXPOSE` port and your `package.json` for a known web framework (Express, Next.js,
Fastify, NestJS, Astro, …), then defaults the "is this a web service?" and port prompts
accordingly (the Dockerfile `EXPOSE` wins over a framework default). Pass the flags above to skip
prompts entirely (CI / scripted use).

---

## `doctor`

Preflight your environment **before** the first deploy (and before any spend). Runs read-only
checks and reports `pass` / `warn` / `fail` for each — it provisions nothing.

```bash
launchpad doctor                       # check the default region
launchpad doctor --region us-west-2    # check a specific region
launchpad doctor --json                # machine-readable (for CI)
```

| Check | What it verifies |
| ----- | ---------------- |
| Docker + buildx | `docker buildx` is installed and the daemon is reachable |
| AWS credentials & region | your identity resolves (STS) and a region is configured |
| S3 state bucket | the per-account/region state bucket is reachable (`warn` if it doesn't exist yet — it's created on first deploy) |
| ECR access | an ECR authorization token can be obtained |
| default VPC | a default VPC exists in the region (custom networking isn't supported yet) |
| golden AMI | a golden AMI is available for the region (`warn` if not — nodes full-bootstrap AL2023, a slower first boot) |

If AWS credentials/region can't be resolved, the AWS-dependent checks are **skipped** (not
failed). Exit code is non-zero when any check **fails** (warnings and skips don't fail), so
`launchpad doctor` is safe to gate a CI pipeline on.

---

## `setup`

Run with **no subcommand** for the guided **first-run bootstrap**; the subcommands generate
copy-paste IAM + CI templates so you don't have to attach `AdministratorAccess`.

### `setup` (first-run wizard)

```bash
launchpad setup                                  # guided default-cluster bootstrap (interactive)
launchpad setup --region us-west-2 --yes         # scriptable, no prompts
launchpad setup --cluster prod --region us-east-1 --yes   # also set up a named cluster
```

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Region to bootstrap (skips the region prompt) |
| `--cluster <name>` | Set up a named cluster (saves a `~/.launch-pad` target + `cluster.json`); default is the implicit `default` cluster |
| `--yes` | Skip the confirmation prompt (required in CI / non-interactive) |

It resolves your AWS account (via STS), picks a region (prompted on a TTY, or `--region`),
and creates the account+region **state bucket** if missing (idempotent — your app data is
untouched), then prints next steps. For the implicit `default` cluster it saves nothing
locally (it runs on ambient AWS creds); its value is ensuring the bucket exists so the first
`deploy` doesn't 403. For a `--cluster <name>` it also saves the local target and writes
`cluster.json` (equivalent to `cluster create`). Interactive on a TTY; fully scriptable with
flags + `--yes`.

### `setup iam-policy`

Print a **least-privilege IAM policy** for the operator (the human or CI principal that runs
`launch-pad`). It grants exactly the permissions deploy/provision/manage need, scoped to the
launchpad state bucket, ECR repos, the `launch-pad-node-*` IAM roles, `/launch-pad/*` secrets,
CloudWatch Logs, and a **single region** (an `aws:RequestedRegion` condition on EC2).

```bash
launchpad setup iam-policy                                  # for your current account + region
launchpad setup iam-policy --json > operator-policy.json    # just the document
launchpad setup iam-policy --account 111122223333 --region us-west-2   # offline (no AWS call)

# Then create + attach it:
aws iam create-policy --policy-name launch-pad-operator \
  --policy-document file://operator-policy.json
aws iam attach-user-policy --user-name <you> \
  --policy-arn arn:aws:iam::<account>:policy/launch-pad-operator
```

With both `--account` and `--region` it runs fully offline; otherwise it resolves them from
your current identity (STS). The policy is **region-scoped** — generate one per region you
deploy to. It is sized to fit a single managed policy (≤ 6144 chars). The policy is for a
**trusted** operator: it can create/manage the `launch-pad-node-*` roles and pass them to EC2,
so don't hand it to an untrusted principal without adding an IAM permissions boundary.

> Verified end-to-end against real AWS: `pnpm e2e:operator-iam` mints a temp IAM user with
> **only** this policy and runs a full provision → deploy → destroy under it (and
> asserts it can't act outside its scope or region).

### `setup github-oidc`

Print a **GitHub Actions OIDC** trust policy + a ready-to-commit deploy workflow, for keyless
CI deploys (GitHub Actions assumes an IAM role via OIDC — no long-lived access keys in repo
secrets).

```bash
launchpad setup github-oidc --repo acme/widgets               # branch main (default)
launchpad setup github-oidc --repo acme/widgets --branch release
launchpad setup github-oidc --repo acme/widgets --json        # both artifacts as one JSON object
```

| Option | Effect |
| ------ | ------ |
| `--repo <owner/name>` | (required) the GitHub repo allowed to assume the role |
| `--branch <name>` | pin the role to one branch (default `main`) — only that branch's workflow can assume it |
| `--all-branches` | allow **any** ref (branches, tags, **and pull requests, including from forks**) — broader; prefer a pinned branch |
| `--role-name <name>` | IAM deploy-role name (default `launch-pad-deploy`) |

The trust policy pins the audience to `sts.amazonaws.com` and the subject to your repo/branch,
so no other repository can assume the role. Pair the role with `setup iam-policy` for its
permissions:

```bash
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com                                   # once per account
aws iam create-role --role-name launch-pad-deploy \
  --assume-role-policy-document file://launch-pad-oidc-trust.json
aws iam attach-role-policy --role-name launch-pad-deploy \
  --policy-arn arn:aws:iam::<account>:policy/launch-pad-operator
```

The generated **`.github/workflows/deploy.yml`** is keyless (OIDC), runs on a push to your
branch (and `workflow_dispatch` for manual runs), and is **concurrency-guarded** — `deploy` is
CAS-protected against concurrent writers, so the workflow runs one deploy per ref at a time and
cancels a superseded run rather than racing it. The steps are: checkout → assume the role via
OIDC → set up Docker Buildx → `npx @agentsystemlabs/launch-pad deploy --yes`.

**Caching guidance** (CI build speed):

- **Pin the CLI version** for reproducible deploys — replace `@agentsystemlabs/launch-pad` with
  `@agentsystemlabs/launch-pad@<version>` in the `npx` step (an unpinned `npx` floats to latest).
- **Cache the CLI download** if your repo has a `package-lock.json`: add `cache: npm` to the
  `actions/setup-node` step (the generated workflow leaves it commented because the cache needs a
  detectable lockfile).
- **Docker build time** usually dominates. `deploy` runs Buildx internally, so the biggest lever
  is your **Dockerfile layer order** — copy dependency manifests and install deps *before* copying
  source, so an unchanged-deps build reuses cached layers. (An unchanged app still produces the
  same content-addressed ECR tag, so the push is a no-op, but the local image is rebuilt.)
- For heavy/frequent builds, a **self-hosted runner** (warm Buildx + Docker layer cache on disk)
  or a registry-backed Buildx cache is the next step.

---

## `deploy`

Build Docker images, push to ECR, and publish desired state to S3. Auto-provisions missing
nodes and resumes paused ones (with confirmation unless `--yes`), repairs EC2 console drift
before publishing, and waits for the agent to report convergence.

Placement is **automatic**: the scheduler bin-packs services across the cluster's app nodes
by free CPU/memory, and every web domain routes through the cluster's **dedicated edge node**
(every cluster is at least 2 nodes — the edge + ≥1 app node). Deploy handles the node-pool
gaps itself: it **bootstraps an empty cluster** (the `edge-1` edge, default `t4g.nano`, plus
a first auto-sized app node) and **auto-adds app nodes** (generated `<noun>-<verb>-<adverb>`
names) when the current pool can't
fit the deploy (e.g. after a replica scale-up) — both spend-gated like any provision, and
both disabled by `--no-create`.

```bash
launchpad deploy [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Deploy only this service |
| `--changed <ref>` | Deploy only services whose build context/Dockerfile changed since this git ref (monorepo CI) |
| `--env <name>` | Named environment: projects domains + namespaces the footprint |
| `--ttl <duration>` | Env lifetime (`30m`/`72h`/`7d`) — [`destroy --prune-expired`](#destroy) tears the env down after it. Requires `--env` |
| `--no-create` | Fail if a needed node is missing (disables edge/app bootstrap + capacity auto-add) |
| `--no-repair` | Fail on EC2 console drift instead of repairing |
| `--no-recreate` | Repair stopped nodes but fail on terminated instances |
| `--no-wait` | Don't wait for agent convergence |
| `--timeout <seconds>` | Convergence timeout (default `180`) |
| `--yes` | Skip confirmation prompts (required for auto-provision in CI) |
| `--dry-run` | Plan only — no image push, S3 writes, or node creation |
| `--ami <id>` | AMI id for auto-provisioned/recreated nodes |
| `--restart` | Skip build/push; re-publish desired state and roll containers |
| `--allow-new-services` | Permit new `[[service]]` blocks (e.g. add `admin` to an existing footprint) |
| `--image <uri>` | Skip build/push; redeploy an existing ECR tag of one `--service` (rollback / promote) |
| `--remote-build` | Build images on AWS CodeBuild instead of local docker (slim CI runners) |

```bash
launchpad deploy
launchpad deploy --service web --no-wait
launchpad deploy --changed origin/main --yes   # CI: deploy only what changed
launchpad deploy --remote-build --yes          # CI runner without a docker daemon
launchpad deploy --env staging
launchpad deploy --env pr-123 --ttl 72h --yes  # PR preview that auto-expires
launchpad deploy --yes               # CI
launchpad deploy --dry-run
launchpad deploy --restart --service api   # roll containers after a secret rotation
launchpad deploy --allow-new-services --service admin   # add a new service to an existing footprint
launchpad deploy --service web --image <uri>   # redeploy an existing tag (rollback)
```

**`--changed <ref>`** is first-class "deploy changed services only" for **monorepos**. It runs
a git diff between `<ref>` and your working tree (committed, uncommitted, and untracked files
all count, because they all land in the image a rebuild would push) and deploys only the
services whose **build inputs** changed — i.e. a changed file lives under the service's docker
`context` directory, or is its `dockerfile`. Unchanged services keep their previously-published
image. Wire it into CI as `launchpad deploy --changed origin/main --yes` (or `--changed
${{ github.event.before }}`). With **no** service changed it's a clean no-op that exits `0`, so
a docs-only commit doesn't fail the deploy job. Config-only edits (`cpu`/`replicas`/`env` in
`launch-pad.toml`) are **not** build inputs — use [`scale`](#scale) / [`config set`](#config)
or a full `deploy` for those. Mutually exclusive with `--service`, `--image`, and `--restart`.

A `--changed` (or `--service`) deploy is a **partial** deploy: it **upserts** into each node's
desired state, preserving the project's other services co-located on the same node (it does not
republish the whole footprint), so deploying one service never tears down its siblings.

**`--image <uri>`** redeploys an existing immutable ECR tag of **one** `--service` without
building — for rolling back to a known-good build or promoting a tested one. The URI must be a
tagged image in that service's own ECR repo (`<project>/<service>:<tag>`) and the tag must
already exist; the service must already be deployed (it re-rolls in place, health-gated).
Container config (`cpu`/`memory`/`replicas`/`env`/`secrets`) still comes from the current
`launch-pad.toml`, so the [config lock](configuration.md#config-lock) applies as usual.
Re-running with the same image is an idempotent no-op (no container churn). Mutually exclusive
with `--restart`. ECR keeps every immutable tag, so any prior build is always available to roll
back to — this is why `destroy` deliberately leaves images in place.

**`--remote-build`** builds every image on **AWS CodeBuild** instead of local docker — for slim
CI runners (or laptops) with no docker daemon. Per service, deploy packs the build context into
a tarball, uploads it under the footprint's `builds/` prefix in the state bucket, and runs one
build in a per-cluster CodeBuild project (`launch-pad-build-<cluster>`) that produces the
**same immutable, content-addressed architecture-matched tag** the local buildx path would
(`linux/arm64` on Graviton, `linux/amd64` on x86). Everything
after the build — merge, publish, convergence watch — is identical, and an image already in ECR
skips its build the same way.
ARM builds run on CodeBuild's ARM container environment so Dockerfile `RUN` steps execute
natively instead of trying to emulate the target platform.

The tarball honors `.dockerignore` for what gets **uploaded**: literal paths, root-level globs
(`*.pem`, `.env*`), and any-depth `**/`-prefixed patterns are excluded from the upload — so the
glob patterns people guard secrets with keep those files **out of S3**, exactly as docker keeps
them out of the build. Unsupported glob shapes (and everything, when a `!negation` makes
exclusion unsafe for the build) upload anyway but are still ignored by docker remotely — the
full `.dockerignore` ships in the tarball. Anything truly sensitive should not live in the
build context at all (use `secrets`).

First use creates the CodeBuild project plus a least-privilege service role
(`launch-pad-codebuild-<cluster>`) that can only read its **own cluster's** `builds/` tarballs
(never `desired.json`/`status.json`), push to ECR, and write its own build logs;
`cluster destroy` removes project, role, and log group. The uploaded tarball is deleted after
each build. The dockerfile must live **inside** its build `context` (the tarball is all
CodeBuild sees). On a failed build the CLI prints the failing command's log context.

⚠️ **Docker Hub rate limits:** CodeBuild egresses through shared NAT IPs that Docker Hub
aggressively throttles for anonymous pulls (`429 Too Many Requests` on `FROM node:…`). The
buildspec retries the build up to 3× with backoff, but for reliable remote builds prefer AWS's
mirror of the official images — e.g. `FROM public.ecr.aws/docker/library/node:24-alpine` —
which has no rate limit from CodeBuild.

CodeBuild bills per build minute (small Linux instances; expect ~$0.01–0.03 per typical
build). Mutually exclusive with `--restart` / `--image`, which skip building entirely. Wire it
into CI as `launchpad deploy --remote-build --yes`.

**`--env <name>` is a named (parallel) environment** — staging, develop, a PR preview. The footprint becomes
`<project>-<env>` (coexisting with prod on the same nodes), every web domain is **projected**
— via the service's `domainPattern` (`{env}`/`{service}` tokens), or by suffixing the first
label (`app.example.com` → `app-pr-123.example.com`). DNS stays **yours to configure**: one
wildcard DNS-only A record at the edge's Elastic IP (e.g. `*.example.com → <edge EIP>`)
covers every projected env subdomain — the deploy's DNS panel prints the exact targets (and
the wildcard, when a `domainPattern` makes one possible), and
[`dns verify`](#dns-verify) checks them. Each `--env` deploy also writes an **env marker**
(`projects/<project>-<env>/preview.json`) recording the env's domains and — with `--ttl` —
an expiry deadline. [`destroy`](#destroy) operates
on those markers; `--ttl` on a later re-deploy re-arms the deadline (a re-deploy without
`--ttl` keeps the existing one).

---

## `destroy`

The inverse of `deploy`: remove a deployment — the whole base footprint, one of its services,
or a named environment. The agent on each node stops the containers on its next poll.
Infrastructure teardown stays separate: [`node destroy`](#node-destroy) for EC2 nodes,
[`cluster destroy`](#cluster) for whole clusters.

This is also the sanctioned way to drop a service the
[config lock](configuration.md#config-lock) otherwise freezes: deleting a `[[service]]` block
and re-deploying aborts with "service removed", but `destroy` removes it cleanly and **trims
the config baseline** so a follow-up `deploy` of the edited `launch-pad.toml` passes the lock.

```bash
launchpad destroy [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Destroy only this service (default: the whole project footprint) |
| `--env <name>` | Destroy a named environment created by `deploy --env`: containers + S3 state |
| `--project <name>` | With `--env`: scope the env teardown (when several projects share the env name). Alone: destroy **all of the project's components** — every base + env footprint and the component registry (TOML-less). Also filters `--list-envs` |
| `--component <name>` | Component the env belongs to (when one project's components share an env name; also filters `--list-envs`) |
| `--list-envs` | List the cluster's environments (project, component, env, expiry, domains) instead of destroying |
| `--prune-expired` | Destroy every env whose `deploy --ttl` deadline has passed (dry-run without `--yes`; cron-able) |
| `--purge-secrets` | Also delete the removed services' SSM secrets (irreversible; off by default) |
| `--no-wait` | Don't wait for the agent to stop the containers |
| `--timeout <seconds>` | How long to wait for the containers to stop (default `120`) |
| `--yes` | Skip the confirmation prompt (required with `--json` for `--env` / `--prune-expired`) |

```bash
launchpad destroy --service worker          # remove one service, keep the rest
launchpad destroy                           # remove the whole base footprint
launchpad destroy --env pr-123 --yes        # tear a PR env down (containers + state)
launchpad destroy --list-envs               # what environments exist?
launchpad destroy --prune-expired --yes     # reap every TTL-expired env (cron/CI)
launchpad destroy --service api --purge-secrets
launchpad destroy --project shop --yes      # whole logical project: every component + env
launchpad destroy --project shop --env pr-7 --yes  # one env across ALL of shop's components
```

**Base footprint** (no `--env`) requires a `launch-pad.toml` in cwd (or a parent):

- **Single service:** drops it from every node's `desired.json` and trims the baseline to the
  remaining services. Afterward, delete its `[[service]]` block from `launch-pad.toml`.
- **Whole footprint** (no `--service`): removes every service and **clears the baseline**, so
  the next `deploy` is a fresh first deploy with identity unlocked again.
- DNS is never touched — it's yours to manage at your provider.

**Named environment** (`--env <name>`) is marker-driven — it works without a
`launch-pad.toml` in cwd, so a PR-close job can run it from anywhere:

- Undeploys the env's whole footprint, waits for the drain, and sweeps its `projects/` state
  (marker, deploy events, baseline). DNS is never touched — a wildcard record keeps covering
  the envs that remain, and per-env records are yours to remove at your provider.
- Only marker-backed environments are eligible — the base project's footprint can never be
  destroyed via `--env`, and other footprints co-located on the same nodes are never touched
  (the teardown reuses the ownership-scoped undeploy planner).
- `--service <name> --env <name>` removes one service from the env's footprint (needs the
  `launch-pad.toml`, like a base partial; leaves the marker alone).
- With components (federated multi-repo deploys), the env teardown is scoped to the cwd
  TOML's component by default; `--component <name>` disambiguates without a TOML, and an
  explicit `--project <name> --env <name>` destroys that env across **all** components.

**Whole project** (`--project <name>`, no `--env`) is registry-driven and TOML-less: it
reads the project's component index (written by every deploy), destroys each component's
env footprints (marker-driven) and base footprint, sweeps their `projects/` state, and
finally deletes the index. A partial failure keeps the registry so a retry can finish.
Other projects' services on shared nodes are never touched.

**`--prune-expired`** is one cron-able reconcile pass (no daemon — same model as
`autoscale run`): destroy every env whose `--ttl` deadline has passed, keep the rest. Without
`--yes` it's a dry run that only lists the expired envs. Envs deployed without `--ttl` never
expire. A failed teardown keeps the env's marker, so the next pass retries it. In `--json`
mode it requires `--yes` (it destroys environments — automation must be explicit).

- **ECR images are kept** in every mode — immutable + content-addressed, they cost almost
  nothing and preserve rollback. **SSM secrets are kept** unless you pass `--purge-secrets`.
- Another project's services on the same node are never touched (ownership-scoped merge).
- Typical PR wiring: the PR workflow deploys with `--env pr-<n> --ttl 72h`; a scheduled
  workflow runs `destroy --prune-expired --yes --json`; the PR-close job runs
  `destroy --env pr-<n> --yes`.

---

## `rollback`

Redeploy a service's **previous** image — or a specific `--to <tag>` — without rebuilding.
A thin, ergonomic wrapper over [`deploy --image`](#deploy): it reads the service's currently
published image, finds the build pushed just before it (by ECR push time), and re-rolls in
place (health-gated, zero-downtime).

```bash
launchpad rollback [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Service to roll back (required when the project has multiple) |
| `--to <tag>` | Roll to a specific immutable tag (can roll forward) instead of the previous build |
| `--env <name>` | Target a named environment footprint (same as `deploy --env`) |
| `--no-wait` | Don't wait for the agent to report convergence |
| `--timeout <seconds>` | Convergence timeout |
| `--dry-run` | Show the `from → to` roll without deploying |
| `--yes` | Skip the confirmation prompt |

```bash
launchpad rollback --service web              # to the previous build
launchpad rollback --service web --to sha-abc123
launchpad rollback --service web --dry-run    # preview from → to
```

- The auto-pick is the most-recent build **strictly older** than what's deployed; if there's
  nothing older it asks for `--to <tag>` (rollback never silently rolls forward).
- Container config (`cpu`/`memory`/`replicas`/`env`/`secrets`) comes from the current
  `launch-pad.toml`, and the chosen image is re-validated to the service's own ECR repo — so a
  rollback can only ever re-point a service at one of its own immutable builds.

---

## `history`

Show the project's deploy history. Every `deploy` appends an **append-only** event to S3 (per
footprint) recording who deployed, when, which image per service, how it ran (`build` /
`restart` / `image`), and whether it converged.

```bash
launchpad history [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Only deploys that touched this service |
| `--env <name>` | Target a named environment footprint (same as `deploy --env`) |
| `--limit <n>` | How many deploys to show (default `10`) |

```bash
launchpad history                       # the last 10 deploys
launchpad history --service web --limit 20
launchpad history --env staging
```

History is **advisory** — an audit trail and a hint for which tags `rollback` can target — and
is never read by the node agents. Events hold only image tags + the caller ARN (no secret
values), and live under `…/projects/<footprint>/events/`.

---

## `status`

Show service status from each node's `status.json` in S3.

```bash
launchpad status [options]
```

| Flag | Description |
| ---- | ----------- |
| `--node <nodeId>` | Only this node (default: the nodes the footprint is deployed on) |
| `--env <name>` | Only this environment's footprint (`<project>-<env>`) |
| `--watch` | Re-poll until interrupted |

A **scheduled (cron) service** reports a `cron` rollup per service — `lastRunAt`,
`lastExitCode`, `nextRunAt` — and stays state `running` while armed between fires (a failed
run surfaces through the exit code and message, not an `error` state).

---

## `logs`

Stream a service's logs from CloudWatch, merged across all nodes/replicas. Run from the
project directory (`launch-pad.toml` resolves the project).

BYOS nodes enrolled with `node init` use the Rust agent's direct CloudWatch Logs shipper; no
separate CloudWatch Agent is required. Older external nodes enrolled before direct logging can
still be inspected locally with `journalctl -u launch-pad-agent` and `docker logs` until they
are upgraded/re-enrolled with the journald forwarder.

```bash
launchpad logs <service> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--env <name>` | Read the named environment's footprint |
| `--since <window>` | How far back: `15m`, `1h`, `24h`, `7d` (default `15m`) |
| `--tail <n>` | Only the last N lines of the window |
| `--follow` | Keep streaming new lines (like `tail -f`) |
| `--filter <pattern>` | CloudWatch filter pattern |

---

## `job`

Run a top-level `[[job]]` from `launch-pad.toml` exactly once. Jobs are ignored by normal
`deploy`; they are intended for migration tasks, data backfills, and other CI-gated one-off
work.

```bash
launchpad job run migrate --wait --yes
```

| Flag | Description |
| ---- | ----------- |
| `--env <name>` | Run against a named environment footprint |
| `--no-wait` | Publish the run request and return without waiting for exit |
| `--timeout <seconds>` | How long `--wait` waits for completion (default `300`) |
| `--yes` | Reserved for CI symmetry with deploy/provisioning commands |
| `--remote-build` | Reserved; job runs currently require local Docker buildx |

`job run` builds and pushes the job image, finds the already-deployed footprint node (preferring
the sticky managed-database node when one exists), writes a transient run request into that
node's `desired.json`, and waits for the agent to report the matching run id in `status.json`.
The agent starts one `--restart no` container and records the exit code. A second run of the
same job will not overlap a still-running prior run.

For database migrations, deploy the database first so the job has a node and service DNS target,
then gate the API deploy on migration success:

```bash
launchpad deploy --service primary --yes
launchpad job run migrate --wait --yes
launchpad deploy --service api --yes
```

---

## `secret`

Store sensitive values in **SSM Parameter Store** (SecureString). Key names are registered
in `launch-pad.toml`; values never land in git or S3 `desired.json`.

```bash
launchpad secret set DATABASE_URL --service api    # hidden prompt (or stdin / --value)
launchpad secret list --service api                # names only, never values
launchpad secret get DATABASE_URL --service api    # decrypt for local scripting (see below)
launchpad secret rm DATABASE_URL --service api
launchpad secret import .env.prod --service api              # bulk-load (production / base)
launchpad secret import .env.staging --service api --env staging
cat .env.prod | launchpad secret import - --service api     # from stdin
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Service or job from `launch-pad.toml` (`set` / `rm` / `import` require this) |
| `--env <name>` | Same footprint as `deploy --env` |
| `--no-register` | SSM only — do not add/remove the key in `launch-pad.toml` |
| `--value <value>` | (`set`) value inline (prefer the hidden prompt or stdin in scripts) |
| `--format <mode>` | (`get`) `value` (default), `shell` (`export KEY=…`), or `json` |
| `--quiet` | (`get`) skip the warning when printing raw secret values |
| `--dry-run` | (`import`) show what would be created/overwritten (names only) without writing |

SSM path layout: `/launch-pad/<cluster>/<ownerProject>/<service>/<KEY>` — `<cluster>` comes
from the active `--cluster` and `<ownerProject>` is `<project>-<env>` (just `<project>` for the
base/prod footprint), so **secrets are isolated per cluster and per environment automatically**.
The same `DATABASE_URL` key holds a different value in each.

### `secret import`

Reads a `.env`-style file (`KEY=VALUE` per line; `#` comments, blank lines, and an `export `
prefix are ignored) and writes every pair as a SecureString under the service's per-env SSM
tree, registering each key in `launch-pad.toml` (skip with `--no-register`). This is the
per-environment config mechanism: the TOML `[service.env]` table is shared across all envs,
so to give an environment its own values you `import` its `.env.<env>` into that `--env`.

- **Values can be any string** — URLs containing `#`, JSON, or multi-line private keys
  (wrap multi-line / space-padded values in single or double quotes; unquoted values are taken
  verbatim to end-of-line, so a `#` in a password is preserved). Only the **key** must be a
  valid env-var name (`UPPER_SNAKE`).
- **All-or-nothing:** the whole file is validated first; an invalid key, an empty value, or a
  non-`KEY=VALUE` line aborts the import with a line-numbered list and writes nothing.
- **Existing keys are overwritten** (import is a sync from the file); existing keys not in the
  file are left untouched (it never deletes).
- ⚠️ A key registered in `launch-pad.toml` is required by **every** environment's deploy (the
  agent errors on a missing SSM ref). Keep the key set consistent across envs — import the
  matching `.env.<env>` into each environment so every env's tree has the full set.

After rotating a secret, roll containers without rebuilding:

```bash
launchpad deploy --restart --service api
```

### `secret get`

Decrypts one SSM SecureString and prints it to **stdout** for local scripting (e.g.
`eval "$(launchpad secret get DATABASE_URL --service api --format shell)"` before
`pnpm db:seed`). Avoid CI logs and shared terminals — anyone with your operator IAM can
already read these values in the AWS console.

| Flag | Description |
| ---- | ----------- |
| `--format value` | Raw value only (default; prints a warning unless `--quiet`) |
| `--format shell` | `export KEY='…'` safe for `eval` |
| `--format json` | `{"key":"…","value":"…"}` |

**Operator IAM** (not auto-provisioned): your local AWS profile needs `ssm:PutParameter`,
`ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath`, `ssm:DeleteParameter`,
and `ssm:DescribeParameters` on `arn:aws:ssm:<region>:<account>:parameter/launch-pad/*`.

**Node IAM:** app agents need `ssm:GetParameter` + `ssm:GetParameters` on the same
prefix. New nodes get this automatically; on existing nodes run
`launchpad node upgrade-agent` (refreshes the IAM policy) before the first secrets deploy.

---

## `scale`

Change the **operational** fields the [config lock](configuration.md#config-lock) allows
after the first deploy — `replicas` (horizontal), `cpu` and `memory` (vertical). `scale`
edits `launch-pad.toml` in place, then runs `deploy --service <name>` so the change rolls
out health-gated and zero-downtime.

```bash
launchpad scale replicas web 3        # scale to 3 replicas and roll it out
launchpad scale cpu web 512 --yes     # 512 vCPU shares (1024 = 1 vCPU)
launchpad scale memory worker 1024    # 1024 MB
launchpad scale replicas web 5 --no-deploy   # edit launch-pad.toml only
launchpad scale replicas web 5 --dry-run     # preview; change nothing
```

| Flag | Description |
| ---- | ----------- |
| `--no-deploy` | Edit `launch-pad.toml` only — don't deploy |
| `--dry-run` | Show the change without editing the file or deploying |
| `--yes` | Skip confirmation prompts (e.g. for provisioning a scale-up needs) |
| `--no-wait` | Don't wait for the agent to report convergence |
| `--timeout <seconds>` | How long to wait for convergence |

`scale replicas` refuses a **scheduled (cron) service** — a cron job runs exactly one
container per fire (`scale cpu`/`memory` work normally).

A scale-up that needs more room than the node has fails the capacity admission check (the
same one `deploy` runs) — raise the node's instance type or move services first.

---

## `config`

Edit a service's **non-secret** `env` table (then deploy). Same allowlisted-mutation model
as `scale`; for secrets use [`secret`](#secret), for replicas/cpu/memory use
[`scale`](#scale).

```bash
launchpad config set web FEATURE_FLAGS=beta      # set an env var + roll it out
launchpad config set web LOG_LEVEL=debug --yes
launchpad config unset web FEATURE_FLAGS         # remove it + roll it out
launchpad config set web LOG_LEVEL=debug --no-deploy   # edit only
```

| Flag | Description |
| ---- | ----------- |
| `--no-deploy` | Edit `launch-pad.toml` only — don't deploy |
| `--dry-run` | Show the change without editing the file or deploying |
| `--yes` | Skip confirmation prompts |
| `--no-wait` | Don't wait for the agent to report convergence |
| `--timeout <seconds>` | How long to wait for convergence |

An `env` change is part of a container's config fingerprint, so the deploy rolls the
containers (health-gated) to apply it — no rebuild, since the image is unchanged. Setting an
env key that's also declared as a `secret` aborts the deploy (keep secret values in SSM).

---

## `rebalance`

Replan **all** of a footprint's services across the **current** app pool and republish to
match — reusing each service's already-published image (no rebuild). Use it after adding an
app node (to spread load onto it) or before removing one. The one exception is a
**volume-bearing service**: its placement is sticky (its data lives on one node's disk), so
it never moves.

```bash
launchpad rebalance --dry-run            # preview the moves
launchpad rebalance --yes                # apply them
launchpad rebalance --drain node-prod-2  # evacuate the footprint OFF a node
```

| Flag | Description |
| ---- | ----------- |
| `--drain <node>` | Exclude this node from the pool — evacuate the footprint off it (same as `node evacuate`) |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--dry-run` | Show the moves without writing any state |
| `--yes` | Skip the confirmation prompt |

Run from the project directory. Rebalance is **config-lock-safe**: the `launch-pad.toml` must
match the deployed baseline — only the placement (re-planned over the live pool) changes. It
re-runs the same scheduler `deploy` uses, so a planned move always passes the capacity
admission check.

Convergence is **eventual**: rebalance republishes desired state and each node's agent
reconciles on its next poll (it publishes nodes that gain replicas before nodes that shed them,
but doesn't health-gate across nodes the way a single-node rolling update does). Don't run it
concurrently with a `deploy`/`scale` of the same footprint; a re-run reconciles any interleaving
safely (it's idempotent — a balanced footprint reports "already balanced" and writes nothing).
`--drain` refuses if a **volume-bearing** service lives on the node (its data can't move) and
refuses to drain the last app node.

---

## `autoscale`

Reactive node-pool autoscaling: a **declarative policy** (min/max app nodes + CPU/memory
utilization thresholds) stored in the cluster's `cluster.json`, applied by a one-shot
**reconcile pass** — there is no daemon, matching the no-control-plane design. Cron
`autoscale run` (locally, CI, or a scheduled workflow) for hands-off scaling.

```bash
launchpad autoscale set --min 1 --max 3            # save the policy (cluster.json)
launchpad autoscale show                           # print it
launchpad autoscale run --dry-run                  # what would happen right now?
launchpad autoscale run --yes                      # apply at most ONE scale action
launchpad autoscale off                            # disable (clears the policy)
```

### `autoscale set`

| Flag | Description |
| ---- | ----------- |
| `--min <n>` | Minimum app nodes — maintained even when idle (required) |
| `--max <n>` | Maximum app nodes — utilization never grows past this (required) |
| `--scale-out-percent <p>` | Scale out when **average** pool CPU *or* memory ≥ this % (default 80) |
| `--scale-in-percent <p>` | Scale in when **every** node's CPU *and* memory are below this % (default 30) |
| `--cooldown <seconds>` | Minimum seconds between utilization-driven actions (default 300) |

The thrash guard requires `scale-in % < scale-out %`. Policy lives in `cluster.json`, so
autoscale needs a **named cluster** (the implicit `default` cluster has none).

### `autoscale run`

One reconcile pass: read the policy, observe the live pool (registry + each node's
`status.json` **host utilization sample**, which the agent embeds every stats interval),
ask the pure planner for at most **one** action, apply it, record `lastScaleAt`, exit.

- **Scale out** — provisions a new app node with a generated name (sized like the largest node already
  in the pool, defaulting to `t4g.micro` for an empty ARM pool and inheriting an existing
  x86 pool's architecture; always role `app` behind the cluster's edge) and
  rebalances the project's services onto the new pool. Triggered by the
  `minNodes` floor (which bypasses the cooldown) or by average utilization ≥ the
  scale-out threshold (never past `maxNodes`).
- **Scale in** — drains the least-utilized node via the rebalance machinery, **waits
  for the survivors to converge**, then gives the victim's agent a drain-grace window
  (graceful container stop + upstream-shard retraction) before terminating it. It
  refuses to touch the cluster's edge, refuses if the node still hosts *any*
  service after the drain (another project's, or a volume-bearing one — autoscale never
  orphans workloads), refuses to act when any pool node is missing fresh metrics (a node it
  can't see is assumed busy), and only picks a victim whose **reserved footprint the
  survivors can absorb** — low live utilization never overrides the capacity admission
  check (`cpu`/`memory` are reservations); when no drainable node fits, the pass
  reports why and does nothing.

Before applying an action, the pass **CAS-claims** `lastScaleAt` in `cluster.json`
(conditional PUT): two overlapping runs can't both act — the loser aborts having changed
nothing — and a pass that fails mid-action leaves the cooldown in place, so a cron retry
can't launch instances every interval. Like `rebalance`, avoid running it concurrently
with a `deploy`/`scale` of the same footprint.

| Flag | Description |
| ---- | ----------- |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--dry-run` | Report the planned action without changing anything |
| `--yes` | Skip the confirmation prompts — **required** for billable/destructive actions in `--json`/cron mode |
| `--timeout <seconds>` | Scale-in drain convergence timeout (default 300) |

Run it from the project directory (the rebalance step needs `launch-pad.toml`); `--dry-run`
and no-op passes work from anywhere. Example cron line:

```
*/5 * * * *  cd /path/to/project && launchpad autoscale run --yes --cluster prod
```

Utilization comes from the host sample each agent publishes in its `status.json`
(CPU busy % and memory used % of the whole host, refreshed every `LAUNCHPAD_STATS_INTERVAL_MS`,
60s default). Samples older than 5 minutes — or from a node whose heartbeat is stale — are
ignored, which blocks scale-in entirely (conservative) and simply shrinks the scale-out average.

---

## `dns`

DNS is the most common thing standing between a deploy and working HTTPS: Let's Encrypt's
HTTP-01 challenge only succeeds if the domain's A record points **directly** at the node's
Elastic IP. **DNS is yours to configure** — point each web domain (or a wildcard like
`*.example.com`, which covers every `deploy --env` subdomain too) as an A record at your
edge node's Elastic IP, at any DNS provider. Every
deploy prints the exact targets in its DNS panel; `dns verify` is the CI-friendly check that
you got it right.

### `dns verify`

```bash
launchpad dns verify app.example.com               # look up the expected EIP from the project
launchpad dns verify app.example.com --expect 54.210.10.20   # check any domain, no project needed
launchpad dns verify app-staging.example.com --env staging
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Which service the domain belongs to (disambiguates the expected node) |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--expect <ip>` | Compare against this IPv4 directly (skips the cluster registry lookup) |

Run from the project directory so the expected Elastic IP can be looked up from the cluster
registry (the edge node that fronts the domain). It reports one of:

| Status | Meaning |
| ------ | ------- |
| `ok` | The A record points at the node's Elastic IP — HTTPS can issue. |
| `wrong-ip` | Resolves, but to a different IP than the edge's EIP (e.g. a proxy/CDN sits in front — the record must resolve directly to the edge). |
| `no-records` | No A record (NXDOMAIN or not created yet). |
| `no-expected-ip` | Resolved fine, but the expected EIP couldn't be determined (run from the project dir or pass `--expect`). |

Exit code is non-zero for `wrong-ip` and `no-records` so it's scriptable
in CI. Every `deploy` now also prints a **DNS panel** with each domain's A-record target.

---

## `node`

Manage EC2 nodes — the machines that run your services. Most nodes are managed EC2
instances Launch Pad provisions for you; you can also **bring your own server** (BYOS) and
enroll an existing Linux host with [`node init`](#node-init).

### `node init`

Enroll an **operator-owned** server you already have (a VPS, a bare-metal box, an EC2
instance you manage yourself) as a Launch Pad node, without Launch Pad ever provisioning any
EC2. The CLI provisions only AWS *credentials* for the box (a per-node IAM **user** with the
same least-privilege node policy an EC2 node gets via its instance profile), SSHes in once to
bootstrap it (install Docker for `app` or Caddy for `edge`, drop the agent binary + `agent.json` + an `EnvironmentFile`
with the AWS keys, register a `launch-pad-agent` systemd unit), and writes an `external`
[node registry](architecture.md#external-byos-nodes) entry. From then on an external app box
polls S3, reconciles Docker, and publishes its upstream shard to the cluster's edge; an
external edge box polls upstream shards and reconciles Caddy.

The box must be Linux with **systemd** and a `dnf` or `apt-get` package manager, reachable over
SSH with passwordless `sudo`. External edge hosts must expose public TCP `80`/`443` and have a
stable `--public-ip`; Launch Pad records that IP for DNS guidance but does not allocate or
manage it.

| Flag | Description |
| ---- | ----------- |
| `--host <user@host>` | **(required)** SSH target for the box, e.g. `ubuntu@203.0.113.10` |
| `--role <role>` | `app` (default) or `edge` |
| `--edge <nodeId>` | Pin a specific edge for this app node (required for external app nodes; omitted for edge nodes) |
| `--advertise-ip <ip>` | The IP the edge dials to reach this app box's container host ports (auto-detected over SSH when omitted) |
| `--public-ip <ip>` | **(required for edge)** Stable public IP users point DNS at; optional display IP for app nodes |
| `--cpu <shares>` | Schedulable CPU shares (1024 = 1 vCPU) |
| `--memory <mb>` | Schedulable memory in MB |
| `--name <id>` | Node id (generated `<noun>-<verb>-<adverb>` when omitted) |
| `--ssh-key <path>` | Identity file for SSH (`-i`) |
| `--ssh-port <port>` | SSH port (default 22) |
| `--agent-version <semver>` | Agent version to install |
| `--timeout <seconds>` | Bootstrap timeout (default `180`) |
| `--show-secrets` | Print the generated IAM access key (otherwise redacted as `***`) |
| `--dry-run` | Show the plan (IAM + bootstrap) without changing anything |
| `--yes` | Skip the confirmation prompt |

The generated IAM access key is **shown only once, at creation**. It is **redacted by
default** (and in `--json`); pass `--show-secrets` to print it. It is also written onto the
box (`/etc/launch-pad/agent.env`, mode 600) so the agent can authenticate.

Before creating the IAM user/access key, `node init` runs an SSH preflight:
`sudo -n true` over the provided SSH target. This catches a wrong key/user, unreachable host,
or sudo that would prompt for a password before Launch Pad creates long-lived credentials.
After the IAM user is created, `node init` writes the `provisioning` `node.json` entry before
running the bootstrap so a partial failure can still be cleaned up with `node destroy`.

```bash
# Enroll an existing Ubuntu box as an app node in the prod cluster
launchpad node init --host ubuntu@203.0.113.10 \
  --cpu 2048 --memory 4096 \
  --cluster prod --yes

# Override the detected address when the edge must dial a private/VPN address
launchpad node init --host ubuntu@203.0.113.10 \
  --advertise-ip 10.0.1.50 --cpu 2048 --memory 4096 \
  --cluster prod --yes

# Enroll an operator-owned ingress box as the cluster edge
launchpad node init --host ubuntu@edge.example.com \
  --role edge --public-ip 203.0.113.20 --cpu 512 --memory 512 \
  --cluster prod --yes
```

`deploy` **still never SSHes** into nodes — only `node init` does, and only at enrollment.
Once enrolled, the box is driven exactly like an EC2 node: entirely through S3 (desired →
status), self-healing, idempotent.

When `--advertise-ip` is omitted for an external app node, `node init` runs
`ip -o -4 route get 1.1.1.1` over SSH, extracts the source IPv4 address, and asks you to
confirm it before writing `agent.json` / `node.json`. Use `--advertise-ip` explicitly when the
edge should dial a VPN, VPC, or peered private address instead of the host's default route
address.

Before declaring success for an external app node, `node init` performs a best-effort edge
reachability probe: it starts a one-shot temporary listener on the BYOS host at TCP `20000`,
then asks the EC2 edge over SSM to connect to the chosen advertise IP on port `20000`. A
failure is a warning, not an enrollment failure, but it means web services will 502 or fail
edge health checks until the network path is fixed. External edge enrollment skips this
app-port probe.

If enrollment times out waiting for the first heartbeat, the bootstrap may still be healthy
but slow. Re-run the same `node init` command with `--name <nodeId>`; when the existing entry
is an external node still in `provisioning`, Launch Pad resumes the heartbeat wait and marks
the node `ready` once the agent reports, without creating another IAM key or re-running the
bootstrap.

BYOS app networking checklist:

- Open edge → BYOS host TCP `20000-29999` in the host firewall, security group, VPN ACL, or
  routed LAN policy.
- Confirm or override the detected advertise IP with an address reachable **from the edge**,
  not merely from your laptop.
- Avoid NAT hairpin paths where the edge dials the box's public IP from inside the same NAT;
  use a private/VPC/VPN/peered address instead.
- Re-run `launchpad doctor` after deploying a web service; it probes the edge to live external
  host ports and reports unreachable nodes.

BYOS edge networking checklist:

- Point service A records at the external edge node's `--public-ip` (one wildcard DNS-only A
  record is usually enough for environment subdomains).
- Open public TCP `80`/`443` to the edge host so Caddy can serve traffic and complete ACME
  HTTP/TLS challenges.
- Keep the public IP stable outside Launch Pad; unlike EC2 edge nodes, Launch Pad does not
  allocate an Elastic IP for operator-owned hosts.

**Resolved open decisions (BYOS Phase 1):**

- **One IAM user per external node** (not a shared user) — same least-privilege node policy
  an EC2 node gets, so a compromised box can't read anything beyond its own state. Teardown
  deletes just that user.
- **A single `node init` command** does both credential provisioning and one-shot SSH
  bootstrap — there is no separate "register" + "bootstrap" split.
- **`advertiseIp` is stored in both `agent.json` and `node.json`** — the box reads it from
  `agent.json` (env `LAUNCHPAD_ADVERTISE_IP` overrides), the CLI/edge read it from `node.json`.
- **Target hosts are Linux + systemd** with a `dnf` or `apt-get` package manager; anything
  else fails the bootstrap with a clear error. SSH access and passwordless sudo are checked
  up front with `sudo -n true`.
- **`doctor` checks external-node heartbeat freshness** and warns when a BYOS node is missing
  or stale. When a web service is running on a BYOS node, `doctor` also asks the edge to probe
  that node's live host ports. External nodes are not SSM-managed, so EC2 lifecycle commands
  still skip them with a warning.

### BYOS break-glass SSH equivalents

External nodes are **not SSM-managed**. AWS Systems Manager Run Command, Session Manager,
`node install-logging`, EC2 pause/resume/resize, and the EC2 live-sampling path in
`node monitor --watch` do not reach an operator-owned host. Use the Launch Pad command when
one exists (`node upgrade-agent <external>`, `node rotate-creds <external>`, `node destroy`)
and use SSH for emergency host inspection:

```bash
# Agent health + recent logs
ssh ubuntu@203.0.113.10 'sudo systemctl status launch-pad-agent --no-pager'
ssh ubuntu@203.0.113.10 'sudo journalctl -u launch-pad-agent -n 200 --no-pager'

# App nodes: Docker/container state
ssh ubuntu@203.0.113.10 'sudo docker ps --filter label=launchpad.managed=true'
ssh ubuntu@203.0.113.10 'sudo docker logs <container-id> --tail 200'

# Edge nodes: Caddy state
ssh ubuntu@203.0.113.20 'sudo systemctl status caddy --no-pager'
ssh ubuntu@203.0.113.20 'sudo journalctl -u caddy -n 200 --no-pager'

# Restart after manual host repair
ssh ubuntu@203.0.113.10 'sudo systemctl restart launch-pad-agent'
ssh ubuntu@203.0.113.20 'sudo systemctl restart caddy launch-pad-agent'
```

Credential and lifecycle break-glass:

- To refresh a suspected-stale key, run `launchpad node rotate-creds <name> --host <user@host>
  --ssh-key <path> --yes`; it writes `/etc/launch-pad/agent.env`, restarts the agent, and
  deletes superseded IAM keys after the SSH push succeeds.
- If a key is compromised and the host cannot be reached, revoke it from AWS IAM immediately
  (delete the `launch-pad-node-<cluster>-<node>` access keys or the whole user), then run
  `launchpad node destroy <name> --force --yes` to remove Launch Pad registry/S3 state.
- If the host is repaired after a heartbeat timeout, re-run `node init --name <nodeId>` with
  the same SSH options to resume the heartbeat wait instead of minting another key.

### `node create [name]`

Provision an EC2 instance, bootstrap the agent, and register the node. The name is
optional — when omitted, a generated `<noun>-<verb>-<adverb>` id (e.g. `dog-runs-fast`,
unique within the cluster) is used, so you never have to invent node names.

| Flag | Description |
| ---- | ----------- |
| `--instance-type <type>` | EC2 instance type (default `t4g.micro`) |
| `--role <role>` | `app` or `edge` (default `app`) |
| `--edge <nodeId>` | For an `app` node: pin a specific edge (defaults to the cluster's edge) |
| `--key-name <keypair>` | EC2 key pair for SSH (omit to disable SSH) |
| `--ami <id>` | AMI id (default: Launch Pad golden AMI, falling back to latest Amazon Linux 2023) |
| `--agent-version <semver>` | Agent version to install |
| `--amount <n>` | Create `n` nodes — generated names when `[name]` is omitted; sequential ids from an explicit base (`app` → `app-1`…`app-n`) |
| `--dry-run` | Show plan without creating anything |
| `--yes` | Skip launch confirmation |

An `app` node routes through an edge, resolved in order: explicit `--edge` → the cluster's
`defaultEdge` (set via [`cluster set-edge`](#cluster-set-edge-name-nodeid)) → the cluster's
single edge-role node. So in a cluster that already has an edge you don't pass `--edge` at
all — the new app node auto-attaches to it. The create is refused only when the cluster has
**no** edge yet (create one first with `--role edge`) or has **more than one** edge and no
default (disambiguate with `--edge` or `cluster set-edge`). App nodes are VPC-private (no
public IP); an `edge` node gets the public 80/443 + Elastic IP.

### `node list`

List registered nodes with capacity, heartbeat age, and the `project/service` footprints
scheduled on each node (replicas shown as `×N`, scheduled jobs tagged `(cron)`; app nodes
with nothing placed show `no services`, as do edge nodes which never run containers). Prefixes
in S3 with no `node.json` show as `missing node.json` — leftover state from a partial destroy
or failed provision. `--json` adds a `services` array to each node entry.

### `node prune`

Remove orphaned S3 node prefixes that have objects but no `node.json` registry entry. Safe to
run after destroying nodes; it only sweeps state that `node list` would show as
`missing node.json`.

| Flag | Description |
| ---- | ----------- |
| `--yes` | Skip the confirmation prompt |

```bash
launchpad node prune --yes
```

Re-running `node destroy <name>` on an already-destroyed node also sweeps any leftover prefix.

### `node show <name>`

Show registry entry, desired state, and live status for one node. Capacity is broken
out as **total** (instance size), **used** (scheduled services from `desired.json`),
and **free** (allocatable minus used — allocatable is total minus the host reserve for
the OS and agent).

### `node destroy <names...>`

Fully tear down the node(s) (comma- or space-separated ids): terminate the instance, release
the Elastic IP, delete the security group, **delete the per-node IAM role + instance profile**,
and remove its full S3 prefix (`node.json`, `desired.json`, `status.json`, the agent binary,
`upstream/*`, etc.). Deleting IAM is best-effort + idempotent and only ever touches the
`launch-pad-node-<cluster>-<node>`-named resources (a legacy shared role is left alone).

| Flag | Description |
| ---- | ----------- |
| `--yes` | Skip the confirmation prompt |
| `--force` | Destroy even if the node still hosts services (they will be **orphaned**) |
| `--delete-data` | Acknowledge **permanent data loss** — required to destroy a node holding a persistent volume (a database). `--force` does **not** bypass this |
| `--evacuate` | First move the current project's services off the node(s), wait for them to come up elsewhere, **then** destroy |
| `--env <name>` | Target a named environment footprint for `--evacuate` (same as `deploy --env`) |
| `--timeout <seconds>` | How long `--evacuate` waits for the moved replicas to converge (default 300) |

**Data-loss guard:** a node hosting a **persistent volume** (a `[[database]]` or any
`[[service.volumes]]` service) refuses to be destroyed — terminating the instance wipes the
volume, which is irreversible. This gate is checked **independently of `--force`** (data loss is
not the same as orphaning a stateless container) and evacuation can't move volume data off the
node. Two ways forward: remove the data service first (`launchpad destroy --service <svc>`) so its
volume is gone, then destroy the node; or pass **`--delete-data`** to accept that the volume's
data is destroyed with the instance. A node whose `desired.json` is present but unparseable is
treated as **possibly holding a volume** and refuses the same way (fail-closed).

**Safety:** `node destroy` **refuses** by default when a node still hosts scheduled services —
destroying it would orphan their containers (no node reconciles them anymore). The error lists
which `project/service`s are at risk. Three ways forward:

- **`--evacuate`** (one-shot, recommended) — run it from your project directory and it auto-moves
  this project's services onto the rest of the app pool (= `node evacuate`),
  **waits** for them to be running there, then tears the node down. **Volume-bearing**
  services (their data lives on the node's disk) and **other projects'** services can't be
  auto-moved; if any remain the destroy still
  refuses (evacuate those projects too, or add `--force`). Draining every node — or a node whose
  drain would leave the cluster with no app nodes — can't relocate the replicas, so it refuses.
  It never terminates the node until the footprint is confirmed up elsewhere (a stuck convergence
  aborts with nothing torn down).
- **manual** — `node evacuate <name>` first, watch `launchpad status`, then re-run destroy.
- **`--force`** — destroy now and orphan whatever is still scheduled there.

```bash
launchpad node destroy app-2 --evacuate --yes   # evacuate this project's services, then destroy
launchpad node destroy app-2 --force --yes       # destroy now, orphan its services
```

**External (BYOS) nodes:** for a node enrolled with [`node init`](#node-init)
(`provisioning: "external"`), destroy deletes the per-node IAM **user** (its access keys +
inline policy) and removes the node's S3 prefix — but makes **no EC2 calls and never touches
the server itself**. The box keeps running; the agent simply loses its credentials and stops
reconciling. Tear the host down (or stop the `launch-pad-agent` service) yourself.
Before teardown, destroy best-effort marks the external node `terminating`, which cordons it
out of future placement while IAM/S3 cleanup runs. For a dead BYOS node that still has desired
services, use `node destroy <name> --evacuate --yes`: Launch Pad first republishes the current
project's volume-free services onto surviving app nodes, then deletes the stale node state.
`node pause` / `node resume` / `node resize` manage EC2 instances and are **unsupported** for
external nodes — they error out telling you to manage the server yourself.

To tear down a whole cluster at once, use [`cluster destroy`](#cluster-destroy-name).

### `node evacuate <name>`

Move the current project's services OFF a node — the safe pre-step to
`node pause`/`destroy`/`resize`. Run from the project directory; it replans the footprint across
the rest of the app pool (reusing each service's published image) so the node is freed. It is
exactly [`rebalance --drain <name>`](#rebalance) scoped to the current project.

```bash
launchpad node evacuate node-prod-2 --dry-run
launchpad node evacuate node-prod-2 --yes
```

**Volume-bearing** services **can't** be evacuated — their placement is sticky (the data
lives on that node's disk), so evacuate refuses if one lives on the node (destroy it or
recreate the footprint to move it). A node hosting **other projects** needs each of them evacuated too (run
it from each project dir). Once `launchpad status` shows the node drained, `node destroy`/`pause`
will accept it. To evacuate **and** destroy in one step (with the drain wait built in), use
[`node destroy --evacuate`](#node-destroy-names).

### `node pause <name>` / `node resume <name>`

Stop the EC2 instance to save cost / start it back up. The edge node keeps its Elastic IP
and disk while paused.

### `node resize <name>`

Change a node's EC2 instance type. EC2 can only retype a **stopped** instance, so a plain
resize is stop → modify → start — the node's services are briefly down during the swap. A
paused node stays paused at the new size; shrinking is blocked when the node's scheduled
services (plus rollout surge) no longer fit; an edge node's Elastic IP survives the cycle.
Cross-architecture resize is refused up front (`t3.*` ↔ `t4g.*`): add a node of the target
architecture, rebalance/evacuate onto it, then destroy the old node instead.

`--evacuate` makes it **non-disruptive** for the current project's services
(run from the project directory): it drains them onto the rest of the app pool (=
[`node evacuate`](#node-evacuate-name)), **waits** for them to be confirmed running
elsewhere, resizes the emptied node, then rebalances back and waits again — so a replica is
never down with the instance. It needs another app node with room; it refuses a paused node
(nothing running to protect) and a node hosting a **volume-bearing** service (its data can't
move — plain resize is the path there). Other projects' services on the node still ride the
brief stop/start, and resizing the **edge** node still blips ingress while Caddy restarts.

| Flag | Description |
| ---- | ----------- |
| `--instance-type <type>` | Target instance type (required) |
| `--evacuate` | Drain this project's services first, resize, rebalance back (no downtime for them) |
| `--env <name>` | Environment footprint for `--evacuate` (same as `deploy --env`) |
| `--timeout <seconds>` | How long `--evacuate` waits for each convergence (default 300) |
| `--dry-run` | Show the from→to change (and whether it would drain) only |
| `--yes` | Skip confirmation |

```bash
launchpad node resize node-prod-1 --instance-type t4g.large                  # brief downtime
launchpad node resize node-prod-1 --instance-type t4g.large --evacuate --yes # rolling, no downtime
```

### `node upgrade-agent [name]`

Upload the **role-specific Rust agent binary** to S3 and install it on running nodes. EC2
nodes are restarted via SSM (with manual fallback). A named external (BYOS) node is restarted
over SSH: pass `--host` when you need a user/hostname override, otherwise the CLI uses
`node.json`'s `publicIp` / `advertiseIp` and forwards `--ssh-key` / `--ssh-port` to `ssh`.
With no name, upgrades every EC2 node in the cluster and skips external nodes so SSH details
stay explicit. Each node gets the binary for **its** role (edge → Caddy router, app → Docker
reconciler), and the registry records `agentType: "rust"`. A node still on the legacy
TypeScript agent is migrated in place — the systemd unit is rewritten to run the binary, the
old bundle is removed, and an edge node also stops its now-unneeded Docker daemon — no
re-provisioning. (Build the binaries first: `pnpm build:agent`.)

| Flag | Description |
| ---- | ----------- |
| `--upload-only` | Upload to S3 only — do not restart on-box agents |
| `--agent-version <semver>` | Version recorded in the registry |
| `--host <user@host>` | SSH target for a named external node |
| `--ssh-key <path>` | SSH private key for a named external node |
| `--ssh-port <port>` | SSH port for a named external node |
| `--dry-run` | Show targets without changing anything |
| `--yes` | Skip confirmation |

```bash
launchpad node upgrade-agent byos-app \
  --host ubuntu@203.0.113.10 --ssh-key ~/.ssh/id_ed25519 --yes
```

### `node rotate-creds <name>`

Rotate the long-lived IAM access key for an external (BYOS) node without re-enrolling it. The
command creates a replacement key on the node's per-node IAM user, rewrites
`/etc/launch-pad/agent.env` over SSH, restarts `launch-pad-agent`, then deletes superseded
access keys only after the restart succeeds. If SSH fails, the replacement key is deleted and
the old key remains active.

| Flag | Description |
| ---- | ----------- |
| `--host <user@host>` | SSH target (defaults to the node's `publicIp` / `advertiseIp`) |
| `--ssh-key <path>` | SSH private key |
| `--ssh-port <port>` | SSH port |
| `--dry-run` | Show the rotation plan without creating an access key |
| `--yes` | Skip confirmation |

Recommended cadence: rotate BYOS node credentials at least every 90 days, after operator
turnover, and after any suspected host or key exposure.

Revoke-on-compromise runbook:

1. If the host is still trusted and reachable, run:

   ```bash
   launchpad node rotate-creds byos-app --host ubuntu@203.0.113.10 --ssh-key ~/.ssh/id_ed25519 --yes
   ```

2. If the host may be compromised, remove it from service first:

   ```bash
   launchpad node destroy byos-app --evacuate --yes
   ```

   Then tear down or rebuild the server yourself. `node destroy` deletes the per-node IAM user
   and all of its access keys.

### `node install-logging [name]`

Install the legacy CloudWatch Agent logging support on an existing EC2 node. New Rust agents
ship service logs directly, but this remains useful for older EC2 nodes that lack the system
log forwarders. With no name, targets every EC2 node in the cluster. `--dry-run` / `--yes` as
above.

### `node reconcile [name]`

Repair EC2 console drift: start stopped nodes, replace terminated ones (same node id; the
edge keeps its Elastic IP). `deploy` runs this automatically unless `--no-repair`.

External (BYOS) nodes have no EC2 instance to repair, but `node reconcile` still checks their
heartbeat. A live external node stuck in `provisioning` is marked `ready`; a stale or missing
heartbeat is reported with the same recovery choices as `node list`: restart the host/agent if
it should still be live, or run `launchpad node destroy <name> --evacuate --yes` if the host is
gone.

| Flag | Description |
| ---- | ----------- |
| `--dry-run` | Show drift without changing anything |
| `--no-recreate` | Fail instead of replacing terminated instances |
| `--yes` | Skip confirmation |

### `node monitor <nodeId>`

Graph a node's CPU/memory usage over time. **Historic** mode reads the `launchpad.stats`
samples the agent emits (~60s) to CloudWatch; **live** mode (`--watch`) samples EC2 nodes
over SSM and redraws a sparkline. External (BYOS) nodes are not SSM-managed, so live mode
reads the latest `status.json.host` sample from the agent heartbeat and labels the graph
`from heartbeat`. Resource usage only — for app output use `logs`, for deploy convergence use
`status`.

Heartbeat-sourced BYOS live mode includes host CPU/memory only. Per-service live graphs still
need SSM or historic CloudWatch stats; use `--since` without `--watch` for BYOS service rows.

| Flag | Description |
| ---- | ----------- |
| `--since <window>` | Historic window (`15m`, `1h`, `24h`, `7d`; default `1h`) |
| `--watch` | Live mode: poll over SSM until Ctrl+C |
| `--interval <sec>` | Watch poll interval (default `3`) |
| `--window <duration>` | Watch ring-buffer span (default `5m`) |
| `--service <name>` | Only graph this service (needs `launch-pad.toml`) |
| `--env <name>` | Resolve `--service` against the named environment |

Live mode needs a running, SSM-managed instance and `ssm:SendCommand` on your operator
profile; historic mode needs only `logs:FilterLogEvents`.

---

## `project`

Inspect deployed project footprints in the active cluster (from each node's published
`desired.json` — declarative placement, not live container health). Use [`status`](#status)
for agent-reported rollout state.

```bash
launchpad project list [options]
launchpad project show <name> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--env <name>` | Named environment footprint (`project show` only; same as `deploy --env`) |

Examples:

```bash
launchpad project list --cluster prod
launchpad project show auth-example --cluster prod
launchpad project show auth-example --cluster prod --env pr-123
```

`project list` shows every base footprint and every marker-backed environment in the
cluster, with service counts and node ids. `project show` drills into one footprint:
services, image tags, domains, cron schedules, and which nodes each service is scheduled on.
Named environments also show TTL/expiry and projected domains from the env marker.

**Federated projects** (TOMLs declaring a `component` — see
[configuration](configuration.md)): `project list` labels each footprint with its
component (`shop · auth`, `shop · notes`), and `project show <project>` aggregates the
whole logical project from the component registry — one panel per component, with
`--env <name>` projecting every component's env footprint. Components with no deployed
footprint for the requested env show as empty rather than erroring.

---

## `cluster`

Manage named clusters — scoped groups of nodes that share an edge (and optionally an AWS
account/region via local config).

### `cluster create <name>`

Save the cluster's AWS target locally and write `cluster.json` to S3.

| Flag | Description |
| ---- | ----------- |
| `--role-arn <arn>` | Cross-account role (reserved; not yet supported) |
| `--edge <nodeId>` | Set the cluster's default edge up front |

The implicit `default` cluster cannot be created — it uses un-prefixed S3 keys for backward
compatibility.

### `cluster list`

List the implicit `default` cluster plus named clusters from local config / S3. `default`
is always shown because it is the legacy un-prefixed cluster future commands target when no
named default has been selected.

### `cluster show [name]`

Show cluster config, AWS account/region, member nodes, every service scheduled on
each node (from its published `desired.json` — the declarative source of truth, not live
container status), and every named environment created by `deploy --env` with its
services and node placement. Use [`status`](#status) when you need agent-reported health
and image rollout state. When `name` is omitted, it targets `--cluster`, then your saved
default cluster, then the implicit `default` cluster, matching `deploy`.

### `cluster set-edge [name] <nodeId>`

Set the cluster's default edge (the Caddy router for its web services). The node must have
role `edge`. When `name` is omitted, it targets `--cluster`, then your saved default cluster,
then the implicit `default` cluster. The implicit `default` cluster cannot store a default
edge in `cluster.json`.

### `cluster use <name>` (aliases: `switch`, `target`)

Set the default cluster for future commands. `cluster use default` clears the persisted
default and reverts to the implicit cluster.

### `cluster current`

Show the cluster future commands will target (account, region, profile).

### `cluster pause [name]` / `cluster resume [name]`

Stop or start every node in the cluster concurrently to save money / bring it back up.
When `name` is omitted, both commands target `--cluster`, then your saved default cluster,
then the implicit `default` cluster, matching `deploy`. The edge keeps its Elastic IP + disk.
`--yes` skips confirmation.

### `cluster destroy [name]`

Terminate every node, release IPs, and delete all the cluster's S3 state. Cannot target
`default`. When `name` is omitted, it targets `--cluster`, then your saved default cluster,
then the implicit `default` cluster. `--yes` skips confirmation.

---

## `backup` / `restore`

Disaster recovery for the declarative state in S3 (the authoritative registry — there's no
control-plane database to back up). `backup` exports a cluster's state to a local directory;
`restore` re-uploads it.

```bash
launchpad backup                                  # export the default cluster's state
launchpad backup --cluster prod --out ./prod-backup
launchpad restore ./prod-backup --yes             # re-upload (overwrites existing state)
```

| Command | Description |
| ------- | ----------- |
| `backup [--out <dir>]` | Mirror the cluster's S3 state (registry + `desired`/`status` + config baselines + deploy events) into a local directory keyed by S3 key, plus a `manifest.json`. Read-only; never changes AWS. |
| `restore <dir> [--yes]` | Re-upload a backup directory to S3 for the cluster in its manifest (override with `--cluster`). Gated by a confirmation. Nodes reconcile to the restored desired state on their next poll. |

Backups contain **no plaintext secrets** — `desired.json` stores SSM parameter references, not
values. Restore **fails closed** against a modified backup directory: every file must be a clean
relative key, stay within the target cluster's keyspace, be listed in the manifest, and be under a
sane size cap; symlinks are skipped. ECR images aren't backed up (they're immutable and
rebuildable). The state bucket itself is per account+region and is never deleted by these commands.

---

## `cost`

Estimate the cluster's **ongoing monthly cost** from its registry — the running nodes'
on-demand EC2 + agent S3 polling — with an optional budget gate.

```bash
launchpad cost                              # estimate the current cluster
launchpad cost --cluster prod --budget 100  # warn + non-zero exit if over $100/mo
launchpad cost --idle-days 3                # flag nodes idle longer than 3 days
launchpad cost --json --budget 100          # machine-readable, for CI / scheduled checks
```

| Flag | Description |
| ---- | ----------- |
| `--budget <usd>` | Monthly USD budget — exit non-zero (and flag) when the estimate exceeds it |
| `--idle-days <n>` | Age (days) before an idle node is flagged in the recommendations (default `7`) |

Running EC2 nodes (ready/provisioning) are estimated for EC2 + agent S3. **External (BYOS)**
nodes are labeled as no-EC2-cost and contribute only their agent S3 polling estimate. **Paused**
nodes are noted separately (a stopped instance has no compute/agent charge, but its EBS volume
and Elastic IP still cost — not estimated). It's a baseline, not a bill: it excludes data
transfer, ECR / CloudWatch storage, and gp3 root volumes. With `--budget`, the non-zero exit
makes it gateable in CI or a scheduled job to catch a cluster that grew past its threshold.

It also surfaces **idle-node recommendations** — money spent without work being done:

- **paused** — a stopped node still paying for its EBS volume + Elastic IP. `resume` it or
  `node destroy` it.
- **empty** — a *running* node hosting no services (or an edge routing no domains), burning its
  full EC2 rate for nothing — the recommendation dollar-estimates the wasted compute.

Only nodes idle longer than `--idle-days` (default 7) are flagged. These are advisory — only
`--budget` changes the exit code.

## `alerts`

Check the cluster's health and notify on problems — a probe you run on a schedule (cron / a
GitHub Action) rather than a continuous control plane.

```bash
launchpad alerts check                                            # print any alerts; exit non-zero if any
launchpad alerts check --cluster prod --webhook "$SLACK_WEBHOOK"  # also POST to Slack/Discord
launchpad alerts check --json                                     # machine-readable
```

| Flag | Description |
| ---- | ----------- |
| `--webhook <url>` | POST alerts to this http(s) URL (Slack/Discord/generic JSON). Env: `LAUNCHPAD_ALERT_WEBHOOK`. |
| `--stale <ms>` | Heartbeat staleness threshold (default 60000). |

`alerts check` reads each node's registry entry + `status.json` and flags **real faults on nodes
that are supposed to be running**:

- **heartbeat-stale** — a live node whose agent stopped reporting (or, past a ~10-minute boot
  grace, never reported). The node may be down, the agent crashed, or it lost network.
- **service-unhealthy** — a service in the `error` state, or one wanting replicas but running
  zero (fully down).

It is deliberately quiet on non-faults: a **paused** node's agent is off on purpose, a
still-booting node is given its grace window, and a partially-degraded service (e.g. 2/3 replicas
mid-rollout) doesn't alert. It **exits non-zero** when there's any alert, so a scheduled run can
gate on it; with `--webhook` it also POSTs a Slack/Discord-compatible payload (`text` summary +
structured `alerts`). The webhook URL is operator-supplied (keep it out of source — use the env
var or a CI secret).

## `dashboard`

Run the built-in **read-only web dashboard** — clusters, nodes, services, environments,
deploy history, live CPU/memory, and live logs, rendered from this same CLI's `--json`
output. It never mutates anything; deploys and changes stay in the CLI/CI.

```bash
launchpad dashboard                          # → http://127.0.0.1:4000
launchpad dashboard --project ~/code/my-app  # register a project dir for logs/history
```

| Flag | Meaning |
| ---- | ------- |
| `--port <port>` | Listen port (default `PORT` env or 4000). |
| `--host <host>` | Bind interface (default `127.0.0.1`). Non-loopback **requires** `LAUNCH_PAD_DASHBOARD_TOKEN`. |
| `--project <dir...>` | Register project directory(ies) — `logs`/`history` need a `launch-pad.toml` cwd. The launch cwd auto-registers when it holds one. |
| `--no-open` | Don't open the browser. |

Global `--cluster` / `--profile` / `--region` become the defaults for every read the
dashboard performs. With `LAUNCH_PAD_DASHBOARD_TOKEN` set, every page requires the token
(Bearer header, session cookie, or one-time `?token=…`); comparison is constant-time and
failures are rate-limited. See [dashboard.md](dashboard.md) for pages, SSE streaming,
and the VPS story.

## `completions`

Print a shell-completion script for `launch-pad` / `lpd`, generated from the live command tree
(so it never drifts from the real commands).

```bash
launchpad completions bash  >> ~/.bash_completion
launchpad completions zsh   > "${fpath[1]}/_launch-pad"   # then run: compinit
launchpad completions fish  > ~/.config/fish/completions/launch-pad.fish
```

Completes top-level commands, their subcommands (e.g. `node create`, `cluster use`), and the
global flags. Supported shells: `bash`, `zsh`, `fish`.
