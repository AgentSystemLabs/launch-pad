# Launch Pad

Deploy your apps to **your own** AWS infrastructure — one command.

```bash
npx @agentsystemlabs/launch-pad deploy
```

Launch Pad builds your app into a Docker image, pushes it to ECR, provisions EC2 nodes (if
needed), and runs your services behind Caddy with automatic HTTPS and zero-downtime rolling
updates. You declare what should run in `launch-pad.toml`; an agent on each node reconciles
Docker and Caddy to match. There is **no control-plane server** — the CLI and agents
coordinate entirely through S3 in your account.

## Who it's for

Launch Pad is built for **indie hackers and small teams** who want PaaS-grade ergonomics
(`git push`-style deploys, HTTPS, logs, rollbacks-by-redeploy) **without renting a
platform**. Instead of depending on a third-party service like Heroku, Render, or Fly:

- **You own everything.** Every resource — EC2, S3, ECR, IAM — lives in your AWS account,
  tagged and inspectable. There is no vendor server in the loop and nothing to get locked
  into; it's just Docker + Caddy + systemd on machines you control.
- **You pay cloud prices, not platform markup.** A side project runs on a single
  `t3.small`; `node pause` / `cluster pause` stop idle environments so you stop paying.
- **It scales down to one box and up to a small fleet** — co-located single node, or a
  public edge router fronting private app nodes with replicas and rolling deploys.

AWS is the supported target today; the architecture (state in object storage, a reconciling
agent per VM) is deliberately portable to other major clouds.

## What you get

- **One-command deploys** — build → push → provision → converge, idempotently
- **Automatic HTTPS** via Caddy + Let's Encrypt
- **Zero-downtime rolling updates** — health-gated surge/drain, even at 1 replica
- **Web services and background workers** in one TOML file, multiple projects per node
- **Auto-provisioning** — missing nodes are created from a prebaked golden AMI (fast boots)
- **Private app nodes** behind a dedicated edge router (no public IPs on app nodes)
- **Clusters & auto-placement** — capacity-aware scheduling without naming nodes
- **Environments** — `deploy --env staging` namespaces domains, images, logs, and secrets
- **Secrets** in SSM Parameter Store; **logs** and **metrics** in CloudWatch
  (`launch-pad logs`, `launch-pad node monitor`)
- **Self-healing nodes** — agents reconcile after reboots, crashes, and console drift

## Quick start

```bash
npx @agentsystemlabs/launch-pad init --name my-app --node node-1 \
  --domain app.example.com --port 3000
npx @agentsystemlabs/launch-pad deploy --yes     # builds, provisions, converges
npx @agentsystemlabs/launch-pad status
```

Full prerequisites (Docker, AWS credentials, DNS) and a guided first deploy:
**[docs/getting-started.md](docs/getting-started.md)**.

## Documentation

| Doc | What's in it |
| --- | ------------ |
| [docs/happy-path.md](docs/happy-path.md) | The indie-hacker happy path end-to-end: AWS → first deploy + HTTPS → scale/secrets/rollback → grow to a cluster → tear down safely |
| [docs/getting-started.md](docs/getting-started.md) | Prerequisites, AWS permissions, DNS, first deploy |
| [docs/configuration.md](docs/configuration.md) | The `launch-pad.toml` schema — services, placement, health checks, rollouts, secrets, environments, config lock |
| [docs/cli.md](docs/cli.md) | Complete CLI reference: `init` · `doctor` · `setup` · `deploy` · `undeploy` · `rollback` · `rebalance` · `scale` · `config` · `status` · `history` · `logs` · `secret` · `dns` · `node` · `cluster` · `backup` / `restore` · `cost` |
| [docs/architecture.md](docs/architecture.md) | How it works: the S3 contract, node roles, edge routing, capacity, invariants |
| [docs/agent.md](docs/agent.md) | The node reconciler (TypeScript) and the Rust rewrite |
| [docs/golden-ami.md](docs/golden-ami.md) | The Packer-built golden AMI and node provisioning/bootstrap |
| [docs/dashboard.md](docs/dashboard.md) | The local web dashboard (work in progress) |
| [docs/testing.md](docs/testing.md) | Unit tests, the real-AWS e2e harness, build processes, CI status |
| [docs/codebase-layout.md](docs/codebase-layout.md) | Map of the repo — where each concern lives, where to change what |
| [docs/overview.md](docs/overview.md) | The north-star spec: end-to-end flows and wire contracts |
| [examples/README.md](examples/README.md) | Runnable examples for every feature combination |

## Repository layout

```
packages/shared       the typed CLI ↔ agent contract (Zod schemas)
packages/cli          the CLI — what users run (npx @agentsystemlabs/launch-pad)
packages/agent        the node agent — reconciles Docker + Caddy to desired state
packages/agent-rust   Rust agent rewrite (static binary, baked into the golden AMI)
packages/dashboard    local web UI (Bun; work in progress)
e2e/                  real-AWS end-to-end test harness (opt-in)
examples/             runnable example apps, one per feature combination
infra/packer/         golden AMI template; scripts/ builds it
```

Details and a "where to change what" table: [docs/codebase-layout.md](docs/codebase-layout.md).

## Project status

Working and verified end-to-end against real AWS (see [docs/testing.md](docs/testing.md)),
pre-1.0. The **dashboard is a work in progress**, the **Rust agent** ships in the golden AMI
with the TypeScript agent as the reference implementation, and there is **no CI pipeline
yet** — tests run locally.

## Development

```bash
pnpm install
pnpm build && pnpm test && pnpm typecheck
pnpm --filter @agentsystemlabs/launch-pad dev -- deploy --dry-run   # CLI from source
```

Contributor rules, invariants, and gotchas live in [CLAUDE.md](CLAUDE.md);
testing conventions in [docs/testing.md](docs/testing.md).
