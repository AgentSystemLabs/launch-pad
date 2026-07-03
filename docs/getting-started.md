# Getting started

Everything you need before and during your first deploy. The agent is installed on nodes
automatically — you never install anything on a server by hand.

> Want the whole journey end-to-end (first deploy → HTTPS → scale → rollback → grow to a
> cluster → tear down)? See **[the indie-hacker happy path](happy-path.md)**.

## Prerequisites

### On your machine (where you run the CLI)

| Requirement | Why |
| ----------- | --- |
| **Node.js 20+** (24+ recommended) | Runs `npx @agentsystemlabs/launch-pad` |
| **Docker with Buildx** | `deploy` builds images for the target app node architecture (`linux/arm64` on Graviton, `linux/amd64` on x86) and pushes to ECR. The daemon must be running. |
| **Git** (recommended) | Clean checkouts get immutable image tags from the commit SHA |
| **AWS credentials** | Configure via `aws configure`, an AWS profile, or standard env vars (`AWS_ACCESS_KEY_ID`, etc.) |

Verify before deploying:

```bash
docker buildx version
aws sts get-caller-identity   # confirms credentials work
```

### Installing the CLI

The CLI ships as `@agentsystemlabs/launch-pad` and exposes three binaries: `launchpad`,
`launch-pad`, and the short alias `lpd`.

- **No install (recommended for trying it / CI):** `npx @agentsystemlabs/launch-pad <command>`.
- **Global install:** `npm i -g @agentsystemlabs/launch-pad` (or `pnpm add -g …`), then run
  `launchpad` / `launch-pad` / `lpd` directly.
- **Develop from a clone:** `npm link` from the repo root links all three bins globally and runs
  the TypeScript source on every invocation (no rebuild). Use `pnpm link:dist` when you need to
  test the compiled `dist/` artifact instead.
- **Pin a version** so deploys are reproducible (especially in CI — an unpinned `npx` floats to
  the latest): `npx @agentsystemlabs/launch-pad@<version> deploy`, or add it as a dev dependency
  (`npm i -D @agentsystemlabs/launch-pad@<version>`) and run it via a package script.
- **Upgrade:** `npm i -g @agentsystemlabs/launch-pad@latest` (global) or bump the pinned version.
  The CLI distributes the node agent (a Rust binary per node role), so upgrading the CLI is
  also how you get a newer agent — run `launchpad node upgrade-agent` afterward to roll it
  onto running nodes (it installs the right binary for each node's role).

> The CLI ↔ agent wire contract is versioned, so the safe order when upgrading across a wire
> change is: upgrade the CLI → `node upgrade-agent` (all nodes) → deploy.

Optional: `launchpad completions <bash|zsh|fish>` prints a tab-completion script (see
[cli.md](cli.md#completions)).

### AWS account

Launch Pad creates and manages resources in **your** AWS account. The CLI needs permission
to:

- **EC2** — launch, stop, start, and terminate instances; Elastic IPs; security groups; VPC
- **IAM** — create per-node instance roles and profiles (least-privilege S3 + ECR access)
- **S3** — state bucket (`launch-pad-state-<account>-<region>`) for desired/status JSON
- **ECR** — repositories and image push/pull
- **SSM** — Parameter Store for secrets; Run Command (used by `node upgrade-agent` and live monitoring)
- **STS** — resolve caller identity

Rather than attaching `AdministratorAccess`, generate a **least-privilege operator policy**
that grants exactly the above, scoped to launch-pad's resources and a single region:

```bash
launchpad setup iam-policy --json > operator-policy.json
aws iam create-policy --policy-name launch-pad-operator \
  --policy-document file://operator-policy.json
aws iam attach-user-policy --user-name <you> \
  --policy-arn arn:aws:iam::<account>:policy/launch-pad-operator
```

For keyless CI deploys, `launchpad setup github-oidc --repo <owner/name>` prints the GitHub
OIDC trust policy + a deploy workflow. See [cli.md](cli.md#setup). All created resources are
tagged `launch-pad=true` for discovery and cost allocation.

**Region:** pass `--region <region>` or set it in `~/.launch-pad/config.toml` when using
named clusters. Otherwise the CLI uses your default AWS config region.

### What runs on each node

Every cluster is at least 2 nodes, provisioned automatically by the first deploy, each
with only its role's stack (the agent is a self-contained Rust binary — no Node.js on any
node):

- **Edge** (`t4g.nano` by default): Caddy + the edge agent + CloudWatch/SSM agents. No
  Docker — its only job is routing HTTPS to app nodes, and the slim stack keeps 512 MB
  comfortable. (`t3.micro` or larger also works if you prefer more headroom.)
- **App** (auto-sized, `t4g.micro` floor for new ARM clusters): Docker + the app agent + CloudWatch/SSM agents.
  No Caddy — app containers are reachable only by the edge over the VPC.

### DNS (for web services with HTTPS)

Web services declare a `domain` in `launch-pad.toml`. Before Caddy can obtain a
certificate:

1. Point the domain's **A record** at the edge node's **Elastic IP** at your DNS
   provider. Every `deploy` prints a **DNS panel** with the
   exact IP for each domain (a wildcard like `*.example.com` works too, and covers
   `deploy --env` subdomains).
2. The record must resolve **directly** to the edge — a record fronted by a proxy/CDN
   breaks Let's Encrypt HTTP/TLS challenges.
3. Check it before (or after) deploying with `launchpad dns verify <domain>` — it resolves
   the record, confirms it matches the edge's Elastic IP, and reports the wrong IP or a
   missing record. See [cli.md](cli.md#dns).

Workers (services with no `domain` / `port`) do not need DNS.

## Quick start

From your app directory:

```bash
# 0a. First-run bootstrap: pick a region + create the state bucket (guided).
#     Skippable if you've already deployed in this account+region.
npx @agentsystemlabs/launch-pad setup

# 0b. Preflight: verify Docker, AWS creds/region, S3, ECR, VPC, and the golden AMI
#     before any spend (provisions nothing; exits non-zero on a blocker).
npx @agentsystemlabs/launch-pad doctor

# 1. Scaffold launch-pad.toml (interactive, or pass flags)
npx @agentsystemlabs/launch-pad init \
  --name my-app \
  --domain app.example.com \
  --port 3000

# 2. Point app.example.com → the edge node's Elastic IP (after step 3 creates it)
#    deploy prints the exact IP; verify with `launchpad dns verify app.example.com`

# 3. Deploy (builds, pushes, auto-provisions the edge + app node on first run)
npx @agentsystemlabs/launch-pad deploy --yes

# 4. Watch convergence
npx @agentsystemlabs/launch-pad status

# 5. Tail your app's logs
npx @agentsystemlabs/launch-pad logs web --follow
```

On first deploy, Launch Pad prints a provisioning plan (EC2 instance type, role) and asks
for confirmation. Pass **`--yes`** to skip the prompt (required in CI / non-TTY).

Try the runnable fixture: [`examples/web-worker`](../examples/web-worker)
— a tiny Express web service plus a background worker. The full example matrix
is in [`examples/README.md`](../examples/README.md).

## What gets installed on a node (automatic)

When you run `launchpad node create` (or `deploy` auto-provisions a node), cloud-init uses
the bundled **golden AMI** when one is available for the target region. That AMI already has
**Docker**, **Caddy**, the **Amazon CloudWatch Agent**, **Node.js**, and the **Launch Pad
agent bundle** baked in, so first boot only writes node-specific config and starts services. If
no golden AMI is published for the region, Launch Pad falls back to the latest Amazon Linux
2023 AMI and runs the full bootstrap script.

The node pulls application images from ECR using its instance role — **no static AWS keys on
the box**. See [golden-ami.md](golden-ami.md) for how the AMI is built and how AMI/agent
selection works.

## After the first deploy

- Subsequent `deploy` runs build a new image, push it under an immutable content-addressed
  tag, and roll containers with **zero downtime** (health-gated surge/drain).
- The project's **identity** is locked after the first deploy (domains, ports,
  build inputs, health checks, rollout); the **operational** fields stay open: scale with
  `launchpad scale replicas|cpu|memory`, change non-secret config with `launchpad config
  set`. See [configuration.md](configuration.md#config-lock).
- Add secrets with `launchpad secret set`, then `deploy --restart` to roll them out —
  see [cli.md](cli.md#secret).
- Save money on idle environments with `node pause` / `cluster pause`.
