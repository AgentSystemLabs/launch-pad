<p align="center">
  <img src="assets/launch-pad-icon.png" alt="Launch Pad" width="128" />
</p>

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

> **Alpha Warning — Use with Caution in Production**
>
> Launch Pad is in **alpha** (pre-1.0). APIs, wire formats, and CLI behavior may change
> without notice. It has been tested against real AWS, but you should expect rough edges,
> missing features, and breaking changes between releases. **Do not rely on it for
> production workloads** without thorough testing, backups, and a rollback plan you trust.

## Who it's for

Launch Pad is built for **indie hackers and small teams** who want PaaS-grade ergonomics
(`git push`-style deploys, HTTPS, logs, rollbacks-by-redeploy) **without renting a
platform**. Instead of depending on a third-party service like Heroku, Render, or Fly:

- **You own everything.** Every resource — EC2, S3, ECR, IAM — lives in your AWS account,
  tagged and inspectable. There is no vendor server in the loop and nothing to get locked
  into; it's just Docker + Caddy + systemd on machines you control.
- **You pay cloud prices, not platform markup.** A side project starts on Graviton by default:
  a `t4g.micro` app node plus a `t4g.nano` edge; `node pause` / `cluster pause` stop idle environments so you
  stop paying.
- **It scales down to two boxes and up to a small fleet** — a tiny dedicated edge router
  (`t4g.nano` by default) fronting private app nodes with replicas and rolling deploys.

AWS is the supported target today; the architecture (state in object storage, a reconciling
agent per VM) is deliberately portable to other major clouds.

## What you get

- **One-command deploys** — build → push → provision → converge, idempotently
- **Automatic HTTPS** via Caddy + Let's Encrypt
- **Zero-downtime rolling updates** — health-gated surge/drain, even at 1 replica
- **Web services and background workers** in one TOML file, multiple projects per node
- **Auto-provisioning** — missing nodes are created from a prebaked golden AMI (fast boots)
- **Bring your own server** — enroll existing Linux hosts as app or edge nodes with `launchpad node init` (no EC2 provisioned)
- **Private app nodes** behind a dedicated edge router (no public IPs on app nodes)
- **Clusters & auto-placement** — capacity-aware scheduling without naming nodes
- **Environments** — `deploy --env staging` namespaces domains, images, logs, and secrets
- **Secrets** in SSM Parameter Store; **logs** and **metrics** in CloudWatch
  (`launchpad logs`, `launchpad node monitor`)
- **Self-healing nodes** — agents reconcile after reboots, crashes, and console drift

## Quick start

```bash
npx @agentsystemlabs/launch-pad init --name my-app \
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
| [docs/cli.md](docs/cli.md) | Complete CLI reference: `init` · `doctor` · `setup` · `deploy` · `job` · `destroy` · `rollback` · `rebalance` · `scale` · `config` · `status` · `history` · `logs` · `secret` · `dns` · `node` · `project` · `cluster` · `backup` / `restore` · `cost` · `dashboard` |
| [docs/architecture.md](docs/architecture.md) | How it works: the S3 contract, node roles, edge routing, capacity, invariants |
| [docs/agent.md](docs/agent.md) | The node reconciler (Rust; edge + app binaries) |
| [docs/golden-ami.md](docs/golden-ami.md) | The Packer-built golden AMI and node provisioning/bootstrap |
| [docs/dashboard.md](docs/dashboard.md) | The built-in read-only web dashboard (`launchpad dashboard`) |
| [docs/testing.md](docs/testing.md) | Unit tests, the real-AWS e2e harness, build processes, CI status |
| [docs/releasing.md](docs/releasing.md) | Publishing the CLI to npm via GitHub Actions OIDC Trusted Publishing |
| [docs/codebase-layout.md](docs/codebase-layout.md) | Map of the repo — where each concern lives, where to change what |
| [docs/overview.md](docs/overview.md) | The north-star spec: end-to-end flows and wire contracts |
| [examples/README.md](examples/README.md) | Runnable examples for every feature combination |

## Repository layout

```
packages/shared       the typed CLI ↔ agent contract (Zod schemas)
packages/cli          the CLI — what users run (npx @agentsystemlabs/launch-pad);
                      includes the read-only web dashboard (`launchpad dashboard`)
packages/agent-rust   the node agent (Rust) — edge + app binaries reconciling Caddy / Docker
e2e/                  real-AWS end-to-end test harness (opt-in)
examples/             runnable example apps, one per feature combination
infra/packer/         golden AMI template; scripts/ builds it
```

Details and a "where to change what" table: [docs/codebase-layout.md](docs/codebase-layout.md).

## Project status

Working and verified end-to-end against real AWS (see [docs/testing.md](docs/testing.md)),
pre-1.0. Tests run locally (no test CI yet); releases
publish the CLI to npm via GitHub Actions OIDC Trusted Publishing — see
[docs/releasing.md](docs/releasing.md).

## Development

```bash
pnpm install
pnpm build && pnpm test && pnpm typecheck
pnpm --filter @agentsystemlabs/launch-pad dev -- deploy --dry-run   # CLI from source
```

Contributor rules, invariants, and gotchas live in [CLAUDE.md](CLAUDE.md);
testing conventions in [docs/testing.md](docs/testing.md).

## License

[MIT](LICENSE)
