# CLI reference

Install/run via npx (no global install required). Both `launch-pad` and the short alias
`lpd` are registered as bins.

```bash
npx @agentsystemlabs/launch-pad <command>
```

Commands: [`init`](#init) · [`doctor`](#doctor) · [`deploy`](#deploy) · [`scale`](#scale) ·
[`config`](#config) · [`status`](#status) · [`logs`](#logs) · [`secret`](#secret) ·
[`dns`](#dns) · [`node`](#node) · [`cluster`](#cluster)

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

---

## `init`

Create a `launch-pad.toml` in the current directory.

```bash
launch-pad init [options]
```

| Flag | Description |
| ---- | ----------- |
| `--name <name>` | Project and service name |
| `--node <nodeId>` | Target node id |
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
launch-pad doctor                       # check the default region
launch-pad doctor --region us-west-2    # check a specific region
launch-pad doctor --json                # machine-readable (for CI)
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
`launch-pad doctor` is safe to gate a CI pipeline on.

---

## `setup`

Run with **no subcommand** for the guided **first-run bootstrap**; the subcommands generate
copy-paste IAM + CI templates so you don't have to attach `AdministratorAccess`.

### `setup` (first-run wizard)

```bash
launch-pad setup                                  # guided default-cluster bootstrap (interactive)
launch-pad setup --region us-west-2 --yes         # scriptable, no prompts
launch-pad setup --cluster prod --region us-east-1 --yes   # also set up a named cluster
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
launch-pad state bucket, ECR repos, the `launch-pad-node-*` IAM roles, `/launch-pad/*` secrets,
CloudWatch Logs, and a **single region** (an `aws:RequestedRegion` condition on EC2).

```bash
launch-pad setup iam-policy                                  # for your current account + region
launch-pad setup iam-policy --json > operator-policy.json    # just the document
launch-pad setup iam-policy --account 111122223333 --region us-west-2   # offline (no AWS call)

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
> **only** this policy and runs a full provision → deploy → undeploy → destroy under it (and
> asserts it can't act outside its scope or region).

### `setup github-oidc`

Print a **GitHub Actions OIDC** trust policy + a ready-to-commit deploy workflow, for keyless
CI deploys (GitHub Actions assumes an IAM role via OIDC — no long-lived access keys in repo
secrets).

```bash
launch-pad setup github-oidc --repo acme/widgets               # branch main (default)
launch-pad setup github-oidc --repo acme/widgets --branch release
launch-pad setup github-oidc --repo acme/widgets --json        # both artifacts as one JSON object
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

For **cluster-auto-placed** services (no `node`/`nodes`), deploy also handles two node-pool
gaps automatically: it **bootstraps the first node** when the cluster is empty, and **auto-adds
`app-<n>` nodes** when the current pool can't fit the deploy (e.g. after a replica scale-up) —
both spend-gated like any provision, and both disabled by `--no-create`.

```bash
launch-pad deploy [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Deploy only this service |
| `--node <nodeId>` | Override target node for all services |
| `--env <name>` | Named environment: projects domains + namespaces the footprint |
| `--no-create` | Fail if a referenced node is missing (also disables empty-cluster bootstrap + capacity auto-add) |
| `--no-repair` | Fail on EC2 console drift instead of repairing |
| `--no-recreate` | Repair stopped nodes but fail on terminated instances |
| `--no-wait` | Don't wait for agent convergence |
| `--timeout <seconds>` | Convergence timeout (default `180`) |
| `--yes` | Skip confirmation prompts (required for auto-provision in CI) |
| `--dry-run` | Plan only — no image push, S3 writes, or node creation |
| `--ami <id>` | AMI id for auto-provisioned/recreated nodes |
| `--restart` | Skip build/push; re-publish desired state and roll containers |
| `--image <uri>` | Skip build/push; redeploy an existing ECR tag of one `--service` (rollback / promote) |

```bash
launch-pad deploy
launch-pad deploy --service web --no-wait
launch-pad deploy --env staging
launch-pad deploy --yes               # CI
launch-pad deploy --dry-run
launch-pad deploy --restart --service api   # roll containers after a secret rotation
launch-pad deploy --service web --image <uri>   # redeploy an existing tag (rollback)
```

**`--image <uri>`** redeploys an existing immutable ECR tag of **one** `--service` without
building — for rolling back to a known-good build or promoting a tested one. The URI must be a
tagged image in that service's own ECR repo (`<project>/<service>:<tag>`) and the tag must
already exist; the service must already be deployed (it re-rolls in place, health-gated).
Container config (`cpu`/`memory`/`replicas`/`env`/`secrets`) still comes from the current
`launch-pad.toml`, so the [config lock](configuration.md#config-lock) applies as usual.
Re-running with the same image is an idempotent no-op (no container churn). Mutually exclusive
with `--restart`. ECR keeps every immutable tag, so any prior build is always available to roll
back to — this is why `undeploy` deliberately leaves images in place.

---

## `undeploy`

The inverse of `deploy`: remove a project — or one of its services — from the nodes it runs
on. The agent on each node stops the containers on its next poll. This is the sanctioned way
to drop a service the [config lock](configuration.md#config-lock) otherwise freezes: deleting
a `[[service]]` block and re-deploying aborts with "service removed", but `undeploy` removes
it cleanly and **trims the config baseline** so a follow-up `deploy` of the edited
`launch-pad.toml` passes the lock.

```bash
launch-pad undeploy [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Undeploy only this service (default: the whole project footprint) |
| `--env <name>` | Target a named environment footprint (same as `deploy --env`) |
| `--purge-secrets` | Also delete the removed services' SSM secrets (irreversible; off by default) |
| `--no-wait` | Don't wait for the agent to stop the containers |
| `--timeout <seconds>` | How long to wait for the containers to stop (default `120`) |
| `--yes` | Skip the confirmation prompt |

```bash
launch-pad undeploy --service worker         # remove one service, keep the rest
launch-pad undeploy                          # remove the whole footprint
launch-pad undeploy --env staging --yes      # remove a named-env footprint
launch-pad undeploy --service api --purge-secrets
```

- **Single service:** drops it from every node's `desired.json` and trims the baseline to the
  remaining services. Afterward, delete its `[[service]]` block from `launch-pad.toml`.
- **Whole footprint** (no `--service`): removes every service and **clears the baseline**, so
  the next `deploy` is a fresh first deploy with identity unlocked again.
- Another project's services on the same node are never touched (ownership-scoped merge).
- **ECR images are kept** — immutable + content-addressed, they cost almost nothing and
  preserve rollback. **SSM secrets are kept** unless you pass `--purge-secrets`.

---

## `rollback`

Redeploy a service's **previous** image — or a specific `--to <tag>` — without rebuilding.
A thin, ergonomic wrapper over [`deploy --image`](#deploy): it reads the service's currently
published image, finds the build pushed just before it (by ECR push time), and re-rolls in
place (health-gated, zero-downtime).

```bash
launch-pad rollback [options]
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
launch-pad rollback --service web              # to the previous build
launch-pad rollback --service web --to sha-abc123
launch-pad rollback --service web --dry-run    # preview from → to
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
launch-pad history [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Only deploys that touched this service |
| `--env <name>` | Target a named environment footprint (same as `deploy --env`) |
| `--limit <n>` | How many deploys to show (default `10`) |

```bash
launch-pad history                       # the last 10 deploys
launch-pad history --service web --limit 20
launch-pad history --env staging
```

History is **advisory** — an audit trail and a hint for which tags `rollback` can target — and
is never read by the node agents. Events hold only image tags + the caller ARN (no secret
values), and live under `…/projects/<footprint>/events/`.

---

## `status`

Show service status from each node's `status.json` in S3.

```bash
launch-pad status [options]
```

| Flag | Description |
| ---- | ----------- |
| `--node <nodeId>` | Only this node (default: nodes in `launch-pad.toml`) |
| `--env <name>` | Only this environment's footprint (`<project>-<env>`) |
| `--watch` | Re-poll until interrupted |

---

## `logs`

Stream a service's logs from CloudWatch, merged across all nodes/replicas. Run from the
project directory (`launch-pad.toml` resolves the project).

```bash
launch-pad logs <service> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--env <name>` | Read the named environment's footprint |
| `--since <window>` | How far back: `15m`, `1h`, `24h`, `7d` (default `15m`) |
| `--tail <n>` | Only the last N lines of the window |
| `--follow` | Keep streaming new lines (like `tail -f`) |
| `--filter <pattern>` | CloudWatch filter pattern |

---

## `secret`

Store sensitive values in **SSM Parameter Store** (SecureString). Key names are registered
in `launch-pad.toml`; values never land in git or S3 `desired.json`.

```bash
launch-pad secret set DATABASE_URL --service api    # hidden prompt (or stdin / --value)
launch-pad secret list --service api                # names only, never values
launch-pad secret rm DATABASE_URL --service api
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Service from `launch-pad.toml` (`set` / `rm` require this) |
| `--env <name>` | Same footprint as `deploy --env` |
| `--no-register` | SSM only — do not add/remove the key in `launch-pad.toml` |
| `--value <value>` | Value inline (prefer the hidden prompt or stdin in scripts) |

SSM path layout: `/launch-pad/<cluster>/<ownerProject>/<service>/<KEY>`

After rotating a secret, roll containers without rebuilding:

```bash
launch-pad deploy --restart --service api
```

**Operator IAM** (not auto-provisioned): your local AWS profile needs `ssm:PutParameter`,
`ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath`, `ssm:DeleteParameter`,
and `ssm:DescribeParameters` on `arn:aws:ssm:<region>:<account>:parameter/launch-pad/*`.

**Node IAM:** app/both agents need `ssm:GetParameter` + `ssm:GetParameters` on the same
prefix. New nodes get this automatically; on existing nodes run
`launch-pad node upgrade-agent` (refreshes the IAM policy) before the first secrets deploy.

---

## `scale`

Change the **operational** fields the [config lock](configuration.md#config-lock) allows
after the first deploy — `replicas` (horizontal), `cpu` and `memory` (vertical). `scale`
edits `launch-pad.toml` in place, then runs `deploy --service <name>` so the change rolls
out health-gated and zero-downtime.

```bash
launch-pad scale replicas web 3        # scale to 3 replicas and roll it out
launch-pad scale cpu web 512 --yes     # 512 vCPU shares (1024 = 1 vCPU)
launch-pad scale memory worker 1024    # 1024 MB
launch-pad scale replicas web 5 --no-deploy   # edit launch-pad.toml only
launch-pad scale replicas web 5 --dry-run     # preview; change nothing
```

| Flag | Description |
| ---- | ----------- |
| `--no-deploy` | Edit `launch-pad.toml` only — don't deploy |
| `--dry-run` | Show the change without editing the file or deploying |
| `--yes` | Skip confirmation prompts (e.g. for provisioning a scale-up needs) |
| `--no-wait` | Don't wait for the agent to report convergence |
| `--timeout <seconds>` | How long to wait for convergence |

A scale-up that needs more room than the node has fails the capacity admission check (the
same one `deploy` runs) — raise the node's instance type or move services first.

---

## `config`

Edit a service's **non-secret** `env` table (then deploy). Same allowlisted-mutation model
as `scale`; for secrets use [`secret`](#secret), for replicas/cpu/memory use
[`scale`](#scale).

```bash
launch-pad config set web FEATURE_FLAGS=beta      # set an env var + roll it out
launch-pad config set web LOG_LEVEL=debug --yes
launch-pad config unset web FEATURE_FLAGS         # remove it + roll it out
launch-pad config set web LOG_LEVEL=debug --no-deploy   # edit only
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

Replan a footprint's **cluster-placed** services (those that omit `node`/`nodes`, scheduled by
`schedule`/`topology`) across the **current** app pool and republish to match — reusing each
service's already-published image (no rebuild). Use it after adding an app node (to spread load
onto it) or before removing one. Pinned (`node`/`nodes`) services never move — their placement
is frozen by the [config lock](configuration.md#config-lock).

```bash
launch-pad rebalance --dry-run            # preview the moves
launch-pad rebalance --yes                # apply them
launch-pad rebalance --drain node-prod-2  # evacuate the footprint OFF a node
```

| Flag | Description |
| ---- | ----------- |
| `--drain <node>` | Exclude this node from the pool — evacuate the footprint off it (same as `node evacuate`) |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--dry-run` | Show the moves without writing any state |
| `--yes` | Skip the confirmation prompt |

Run from the project directory. Rebalance is **config-lock-safe**: the `launch-pad.toml` must
match the deployed baseline — only the placement (re-derived from `schedule`/`topology` over the
live pool) changes. It re-runs the same scheduler `deploy` uses, so a planned move always passes
the capacity admission check.

Convergence is **eventual**: rebalance republishes desired state and each node's agent
reconciles on its next poll (it publishes nodes that gain replicas before nodes that shed them,
but doesn't health-gate across nodes the way a single-node rolling update does). Don't run it
concurrently with a `deploy`/`scale` of the same footprint; a re-run reconciles any interleaving
safely (it's idempotent — a balanced footprint reports "already balanced" and writes nothing).
`--drain` refuses if a **pinned** service targets the node (it can't move) and refuses to drain
the last app node.

---

## `dns`

DNS is the most common thing standing between a deploy and working HTTPS: Let's Encrypt's
HTTP-01 challenge only succeeds if the domain's A record points **directly** at the node's
Elastic IP. `dns setup` writes that record for you (Route53), and `dns verify` checks it.

### `dns setup`

If your domain is hosted in **AWS Route53**, `dns setup` creates/updates a **DNS-only** A
record for every web service in the project, pointing each domain at the Elastic IP of the
node that fronts it (its edge, or its co-located node). Records are never proxied, so HTTP-01
issuance works. Run it from the project directory, typically right after a deploy.

```bash
launch-pad dns setup                       # all web services → their fronting node's EIP
launch-pad dns setup --service web --wait  # one service, block until Route53 is INSYNC
launch-pad dns setup --env staging --yes   # an environment footprint, no prompt (CI)
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Only set up DNS for this service |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--ttl <seconds>` | Record TTL in seconds (default 60) |
| `--wait` | Block until Route53 reports the change `INSYNC` |
| `--yes` | Skip the confirmation prompt (required in CI / `--json` writes) |

It shows the plan first and asks before writing (skip with `--yes`). A record that already
points at the right IP is reported `already set` and left untouched (idempotent). Domains
**not** owned by a Route53 hosted zone are **skipped** (with a non-zero exit) — for Cloudflare
or another registrar, add a grey-cloud A record there by hand, then `dns verify`. Requires the
operator policy from `setup iam-policy` (it grants the needed `route53:*` actions).

### `dns verify`

```bash
launch-pad dns verify app.example.com               # look up the expected EIP from the project
launch-pad dns verify app.example.com --expect 54.210.10.20   # check any domain, no project needed
launch-pad dns verify app-staging.example.com --env staging
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Which service the domain belongs to (disambiguates the expected node) |
| `--env <name>` | Environment footprint (same as `deploy --env`) |
| `--expect <ip>` | Compare against this IPv4 directly (skips the cluster registry lookup) |

Run from the project directory so the expected Elastic IP can be looked up from the cluster
registry (the edge node that fronts the domain, or its co-located node). It reports one of:

| Status | Meaning |
| ------ | ------- |
| `ok` | The A record points at the node's Elastic IP — HTTPS can issue. |
| `wrong-ip` | Resolves, but to a different IP than the fronting node's EIP. |
| `cloudflare-proxied` | The A record is a **Cloudflare proxy** IP (orange cloud) — this blocks HTTP-01. Switch the record to **DNS-only** (grey cloud). |
| `no-records` | No A record (NXDOMAIN or not created yet). |
| `no-expected-ip` | Resolved fine, but the expected EIP couldn't be determined (run from the project dir or pass `--expect`). |

Exit code is non-zero for `wrong-ip`, `cloudflare-proxied`, and `no-records` so it's scriptable
in CI. Every `deploy` now also prints a **DNS panel** with each domain's A-record target.

---

## `node`

Manage EC2 nodes — the machines that run your services.

### `node create <name>`

Provision an EC2 instance, bootstrap the agent, and register the node.

| Flag | Description |
| ---- | ----------- |
| `--instance-type <type>` | EC2 instance type (default `t3.small`) |
| `--role <role>` | `app`, `edge`, or `both` (default `both`) |
| `--edge <nodeId>` | For an `app` node: the edge that routes to it |
| `--key-name <keypair>` | EC2 key pair for SSH (omit to disable SSH) |
| `--ami <id>` | AMI id (default: Launch Pad golden AMI, falling back to latest Amazon Linux 2023) |
| `--agent-version <semver>` | Agent version to install |
| `--dry-run` | Show plan without creating anything |
| `--yes` | Skip launch confirmation |

### `node list`

List registered nodes with capacity and heartbeat age.

### `node show <name>`

Show registry entry, desired state, and live status for one node.

### `node destroy <names...>`

Fully tear down the node(s) (comma- or space-separated ids): terminate the instance, release
the Elastic IP, delete the security group, **delete the per-node IAM role + instance profile**,
and remove its S3 state. Deleting IAM is best-effort + idempotent and only ever touches the
`launch-pad-node-<cluster>-<node>`-named resources (a legacy shared role is left alone).

| Flag | Description |
| ---- | ----------- |
| `--yes` | Skip the confirmation prompt |
| `--force` | Destroy even if the node still hosts services (they will be **orphaned**) |
| `--evacuate` | First move the current project's cluster-placed services off the node(s), wait for them to come up elsewhere, **then** destroy |
| `--env <name>` | Target a named environment footprint for `--evacuate` (same as `deploy --env`) |
| `--timeout <seconds>` | How long `--evacuate` waits for the moved replicas to converge (default 300) |

**Safety:** `node destroy` **refuses** by default when a node still hosts scheduled services —
destroying it would orphan their containers (no node reconciles them anymore). The error lists
which `project/service`s are at risk. Three ways forward:

- **`--evacuate`** (one-shot, recommended) — run it from your project directory and it auto-moves
  this project's **cluster-placed** services onto the rest of the app pool (= `node evacuate`),
  **waits** for them to be running there, then tears the node down. Pinned (`node`/`nodes`)
  services and **other projects'** services can't be auto-moved; if any remain the destroy still
  refuses (evacuate those projects too, or add `--force`). Draining every node — or a node whose
  drain would leave the cluster with no app nodes — can't relocate the replicas, so it refuses.
  It never terminates the node until the footprint is confirmed up elsewhere (a stuck convergence
  aborts with nothing torn down).
- **manual** — `node evacuate <name>` first, watch `launch-pad status`, then re-run destroy.
- **`--force`** — destroy now and orphan whatever is still scheduled there.

```bash
launch-pad node destroy app-2 --evacuate --yes   # evacuate this project's services, then destroy
launch-pad node destroy app-2 --force --yes       # destroy now, orphan its services
```

To tear down a whole cluster at once, use [`cluster destroy`](#cluster-destroy-name).

### `node evacuate <name>`

Move the current project's **cluster-placed** services OFF a node — the safe pre-step to
`node pause`/`destroy`/`resize`. Run from the project directory; it replans the footprint across
the rest of the app pool (reusing each service's published image) so the node is freed. It is
exactly [`rebalance --drain <name>`](#rebalance) scoped to the current project.

```bash
launch-pad node evacuate node-prod-2 --dry-run
launch-pad node evacuate node-prod-2 --yes
```

Pinned (`node`/`nodes`) services **can't** be evacuated — their placement is config-locked, so
evacuate refuses if the project pins a service to the node (undeploy it or recreate the
footprint to move it). A node hosting **other projects** needs each of them evacuated too (run
it from each project dir). Once `launch-pad status` shows the node drained, `node destroy`/`pause`
will accept it. To evacuate **and** destroy in one step (with the drain wait built in), use
[`node destroy --evacuate`](#node-destroy-names).

### `node pause <name>` / `node resume <name>`

Stop the EC2 instance to save cost / start it back up. Edge and both-role nodes keep their
Elastic IP and disk while paused.

### `node resize <name>`

Change a node's EC2 instance type (stops + starts it — brief downtime).

| Flag | Description |
| ---- | ----------- |
| `--instance-type <type>` | Target instance type (required) |
| `--dry-run` | Show the from→to change only |
| `--yes` | Skip confirmation |

### `node upgrade-agent [name]`

Upload a fresh agent bundle to S3 and install it on running instance(s) via SSM (with
manual fallback). With no name, upgrades every node in the cluster.

| Flag | Description |
| ---- | ----------- |
| `--upload-only` | Upload to S3 only — do not restart on-box agents |
| `--agent-version <semver>` | Version recorded in the registry |
| `--dry-run` | Show targets without changing anything |
| `--yes` | Skip confirmation |

### `node install-logging [name]`

Install CloudWatch log shipping on an existing node (IAM + CloudWatch Agent). With no name,
targets every node in the cluster. `--dry-run` / `--yes` as above.

### `node reconcile [name]`

Repair EC2 console drift: start stopped nodes, replace terminated ones (same node id;
edge/both keep their Elastic IP). `deploy` runs this automatically unless `--no-repair`.

| Flag | Description |
| ---- | ----------- |
| `--dry-run` | Show drift without changing anything |
| `--no-recreate` | Fail instead of replacing terminated instances |
| `--yes` | Skip confirmation |

### `node monitor <nodeId>`

Graph a node's CPU/memory usage over time. **Historic** mode reads the `launchpad.stats`
samples the agent emits (~60s) to CloudWatch; **live** mode (`--watch`) samples the node
over SSM and redraws a sparkline. Resource usage only — for app output use `logs`, for
deploy convergence use `status`.

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

List locally configured clusters from `~/.launch-pad/config.toml`.

### `cluster show <name>`

Show cluster config, AWS account/region, and member nodes.

### `cluster set-edge <name> <nodeId>`

Set the cluster's default edge (the Caddy router for its web services). The node must have
role `edge` or `both`.

### `cluster use <name>` (aliases: `switch`, `target`)

Set the default cluster for future commands. `cluster use default` clears the persisted
default and reverts to the implicit cluster.

### `cluster current`

Show the cluster future commands will target (account, region, profile).

### `cluster pause <name>` / `cluster resume <name>`

Stop every node in the cluster to save money / start them back up (edge first, then app
nodes). Edge/both nodes keep their Elastic IP + disk. `--yes` skips confirmation.

### `cluster destroy <name>`

Terminate every node, release IPs, and delete all the cluster's S3 state. Cannot target
`default`. `--yes` skips confirmation.

---

## `backup` / `restore`

Disaster recovery for the declarative state in S3 (the authoritative registry — there's no
control-plane database to back up). `backup` exports a cluster's state to a local directory;
`restore` re-uploads it.

```bash
launch-pad backup                                  # export the default cluster's state
launch-pad backup --cluster prod --out ./prod-backup
launch-pad restore ./prod-backup --yes             # re-upload (overwrites existing state)
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
launch-pad cost                              # estimate the current cluster
launch-pad cost --cluster prod --budget 100  # warn + non-zero exit if over $100/mo
launch-pad cost --idle-days 3                # flag nodes idle longer than 3 days
launch-pad cost --json --budget 100          # machine-readable, for CI / scheduled checks
```

| Flag | Description |
| ---- | ----------- |
| `--budget <usd>` | Monthly USD budget — exit non-zero (and flag) when the estimate exceeds it |
| `--idle-days <n>` | Age (days) before an idle node is flagged in the recommendations (default `7`) |

Running nodes (ready/provisioning) are estimated for EC2 + agent S3; **paused** nodes are noted
separately (a stopped instance has no compute/agent charge, but its EBS volume + Elastic IP
still cost — not estimated). It's a baseline, not a bill: it excludes data transfer, ECR /
CloudWatch storage, and gp3 root volumes. With `--budget`, the non-zero exit makes it gateable
in CI or a scheduled job to catch a cluster that grew past its threshold.

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
launch-pad alerts check                                            # print any alerts; exit non-zero if any
launch-pad alerts check --cluster prod --webhook "$SLACK_WEBHOOK"  # also POST to Slack/Discord
launch-pad alerts check --json                                     # machine-readable
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

## `completions`

Print a shell-completion script for `launch-pad` / `lpd`, generated from the live command tree
(so it never drifts from the real commands).

```bash
launch-pad completions bash  >> ~/.bash_completion
launch-pad completions zsh   > "${fpath[1]}/_launch-pad"   # then run: compinit
launch-pad completions fish  > ~/.config/fish/completions/launch-pad.fish
```

Completes top-level commands, their subcommands (e.g. `node create`, `cluster use`), and the
global flags. Supported shells: `bash`, `zsh`, `fish`.
