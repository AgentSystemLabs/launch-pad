# Launch Pad

Deploy your apps to your own AWS infrastructure — one command.

Launch Pad builds your app into a Docker image, pushes it to **ECR**, provisions **EC2**
nodes (if needed), and runs your services behind **Caddy** with automatic HTTPS. You
declare what should run in `launch-pad.toml`; an agent on each node reconciles Docker and
Caddy to match. There is no control-plane server — the CLI and agents coordinate through
**S3**.

```bash
npx @agentsystemlabs/launch-pad deploy
```

---

## Prerequisites

Everything below must be in place **before your first deploy**. The agent itself is
installed automatically when a node is provisioned — you do not install it locally.

### On your machine (where you run the CLI)

| Requirement | Why |
| ----------- | --- |
| **Node.js 20+** (24+ recommended) | Runs `npx @agentsystemlabs/launch-pad` |
| **Docker with Buildx** | `deploy` builds `linux/amd64` images and pushes to ECR. The daemon must be running. |
| **Git** (recommended) | Clean checkouts get immutable image tags from the commit SHA |
| **AWS credentials** | Configure via `aws configure`, an AWS profile, or standard env vars (`AWS_ACCESS_KEY_ID`, etc.) |

Verify Docker before deploying:

```bash
docker buildx version
aws sts get-caller-identity   # confirms credentials work
```

### AWS account

Launch Pad creates and manages resources in **your** AWS account. The CLI needs permission
to:

- **EC2** — launch, stop, start, and terminate instances; Elastic IPs; security groups; VPC
- **IAM** — create per-node instance roles and profiles (least-privilege S3 + ECR access)
- **S3** — state bucket (`launch-pad-state-<account>-<region>`) for desired/status JSON
- **ECR** — repositories and image push/pull
- **SSM** — Run Command (used by `node upgrade-agent` to restart the on-box agent)
- **STS** — resolve caller identity

Use an IAM user or role with broad enough rights for the above in the target region. All
created resources are tagged `launch-pad=true` for discovery and cost allocation.

**Region:** pass `--region <region>` or set it in `~/.launch-pad/config.toml` when using
named clusters. Otherwise the CLI uses your default AWS config region.

### DNS (for web services with HTTPS)

Web services declare a `domain` in `launch-pad.toml`. Before Caddy can obtain a
certificate:

1. Point the domain's **A record** at the node's (or edge's) **Elastic IP**.
2. The record must resolve **directly** to the node — a Cloudflare **proxied**
   (orange-cloud) record breaks Let's Encrypt HTTP/TLS challenges.

Workers (services with no `domain` / `port`) do not need DNS.

### What gets installed on a node (automatic)

When you run `launch-pad node create` or `deploy` auto-provisions a node, cloud-init
installs **Docker**, **Caddy**, and the **Launch Pad agent** (via a bundle from S3), then
registers the agent as a **systemd** service. The node pulls images from ECR using its
instance role — no static AWS keys on the box.

---

## Quick start

From your app directory:

```bash
# 1. Scaffold launch-pad.toml (interactive, or pass flags)
npx @agentsystemlabs/launch-pad init \
  --name my-app \
  --node node-dev-1 \
  --domain app.example.com \
  --port 3000

# 2. Point app.example.com → your node's Elastic IP (after step 3 creates it)

# 3. Deploy (builds, pushes, auto-provisions the node on first run)
npx @agentsystemlabs/launch-pad deploy --yes

# 4. Watch convergence
npx @agentsystemlabs/launch-pad status
```

On first deploy, Launch Pad prints a provisioning plan (EC2 instance type, role) and
asks for confirmation. Pass **`--yes`** to skip the prompt (required in CI / non-TTY).

Try the runnable fixture: [`examples/both-node-web-worker`](examples/both-node-web-worker).

---

## Configuration

Each project has a **`launch-pad.toml`** in the app root. One file can declare multiple
`[[service]]` blocks (web services and background workers).

Minimal web service:

```toml
project = "my-app"

[[service]]
name = "web"
node = "node-dev-1"
dockerfile = "./Dockerfile"
cpu = 512        # vCPU shares (1024 = 1 vCPU)
memory = 512     # MB
domain = "app.example.com"
port = 3000
```

- **Web service:** both `domain` and `port` — gets Caddy + HTTPS.
- **Worker:** omit both — runs in the background, no public URL.
- **Placement:** set exactly one of `node`, `nodes`, or `cluster` per service.
- **Edge routing:** dedicated `edge` + `app` nodes for split public/private topology.

See [`examples/README.md`](examples/README.md) for configs covering replicas, rolling
updates, `--env`, and clusters. The full schema lives in
[`packages/shared/src/config.ts`](packages/shared/src/config.ts).

### Local CLI preferences

`~/.launch-pad/config.toml` stores **local** cluster → AWS target mappings (region,
profile). S3 remains the authoritative registry of nodes and deploy state.

---

## CLI reference

Install/run via npx (no global install required):

```bash
npx @agentsystemlabs/launch-pad <command>
```

### Global options

Available on every command (before or after the subcommand):

| Flag | Description |
| ---- | ----------- |
| `--profile <name>` | AWS profile to use |
| `--region <region>` | AWS region (defaults to AWS config) |
| `--cluster <name>` | Target cluster (default: local default, else `default`) |
| `--json` | Machine-readable JSON (no banner/spinners) |
| `--verbose` | Verbose output; stack traces on error |
| `--no-color` | Disable colored output |
| `-V, --version` | Print version |
| `-h, --help` | Command help |

---

### `init`

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

---

### `deploy`

Build Docker images, push to ECR, and publish desired state to S3. Auto-provisions
missing nodes and resumes paused ones (with confirmation unless `--yes`).

```bash
launch-pad deploy [options]
```

| Flag | Description |
| ---- | ----------- |
| `--service <name>` | Deploy only this service |
| `--node <nodeId>` | Override target node for all services |
| `--env <name>` | Named environment: projects domains + namespaces footprint |
| `--no-create` | Fail if a referenced node is missing |
| `--no-repair` | Fail on EC2 console drift instead of repairing |
| `--no-recreate` | Repair stopped nodes but fail on terminated instances |
| `--no-wait` | Don't wait for agent convergence |
| `--timeout <seconds>` | Convergence timeout (default `180`) |
| `--yes` | Skip confirmation prompts (required for auto-provision in CI) |
| `--dry-run` | Plan only — no image push, S3 writes, or node creation |

**Examples:**

```bash
launch-pad deploy
launch-pad deploy --service web --no-wait
launch-pad deploy --env staging
launch-pad deploy --env dev --node dev-app
launch-pad deploy --yes
launch-pad deploy --dry-run
```

---

### `status`

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

### `node`

Manage EC2 nodes — the machines that run your services.

#### `node create <name>`

Provision an EC2 instance, bootstrap the agent, and register the node.

```bash
launch-pad node create <name> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--instance-type <type>` | EC2 instance type (default `t3.small`) |
| `--role <role>` | `app`, `edge`, or `both` (default `both`) |
| `--edge <nodeId>` | For an `app` node: the edge that routes to it |
| `--key-name <keypair>` | EC2 key pair for SSH (omit to disable SSH) |
| `--ami <id>` | AMI id (default: latest Amazon Linux 2023) |
| `--agent-version <semver>` | Agent version to install |
| `--dry-run` | Show plan without creating anything |
| `--yes` | Skip launch confirmation |

#### `node list`

List registered nodes with capacity and heartbeat age.

#### `node show <name>`

Show registry entry, desired state, and live status for one node.

#### `node destroy <name>`

Terminate the instance, release its Elastic IP, and deregister the node.

| Flag | Description |
| ---- | ----------- |
| `--yes` | Skip confirmation |

#### `node pause <name>`

Stop the EC2 instance to save cost. Edge/both nodes keep their Elastic IP and disk.

#### `node resume <name>`

Start a paused node.

#### `node upgrade-agent [name]`

Upload a fresh agent bundle to S3 and install it on running instance(s) via SSM.

| Flag | Description |
| ---- | ----------- |
| `--upload-only` | Upload to S3 only — do not restart on-box agents |
| `--agent-version <semver>` | Version recorded in the registry |
| `--dry-run` | Show targets without changing anything |
| `--yes` | Skip confirmation |

With no name, upgrades every node in the cluster that has an EC2 instance.

#### `node reconcile [name]`

Repair EC2 console drift: start stopped nodes, replace terminated ones (same node id;
edge/both keep Elastic IP).

| Flag | Description |
| ---- | ----------- |
| `--dry-run` | Show drift without changing anything |
| `--no-recreate` | Fail instead of replacing terminated instances |
| `--yes` | Skip confirmation |

`deploy` runs this automatically before publishing unless `--no-repair` is set.

#### `node monitor <nodeId>`

Graph a node's CPU/memory usage over time. **Historic** mode reads the `launchpad.stats`
samples the agent emits every ~60s to CloudWatch; **live** mode (`--watch`) samples the
node directly over SSM and redraws a sparkline. Resource usage only — for app output use
`logs`, for deploy convergence use `status`.

```bash
launch-pad node monitor <nodeId> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--since <window>` | Historic window from logs (`15m`, `1h`, `24h`, `7d`; default `1h`) |
| `--watch` | Live mode: poll over SSM and redraw until Ctrl+C |
| `--interval <sec>` | Watch poll interval in seconds (default `3`) |
| `--window <duration>` | Watch ring-buffer span (default `5m`) |
| `--service <name>` | Only graph this service (needs `launch-pad.toml` to resolve the project) |
| `--env <name>` | Resolve `--service` against the named environment |

Live mode needs a running, SSM-managed instance and `ssm:SendCommand` on your operator
profile; historic mode needs only `logs:FilterLogEvents`.

---

### `cluster`

Manage named clusters — scoped groups of nodes that share an edge (and optionally an AWS
account/region via local config).

#### `cluster create <name>`

Save the cluster's AWS target locally and write `cluster.json` to S3.

```bash
launch-pad cluster create <name> [options]
```

| Flag | Description |
| ---- | ----------- |
| `--role-arn <arn>` | Cross-account role (reserved; not yet supported) |
| `--edge <nodeId>` | Set the cluster's default edge up front |

The implicit `default` cluster cannot be created — it uses un-prefixed S3 keys for
backward compatibility.

#### `cluster list`

List locally configured clusters from `~/.launch-pad/config.toml`.

#### `cluster show <name>`

Show cluster config, AWS account/region, and member nodes.

#### `cluster set-edge <name> <nodeId>`

Set the cluster's default edge (the Caddy router for its web services). The node must
have role `edge` or `both`.

---

## How it works

```
CLI (local) ──writes desired.json──▶ S3 ◀──polls desired.json── agent (on node)
CLI (local) ◀──polls status.json──── S3 ──writes status.json──▶ agent (on node)
```

The CLI never SSHes into nodes. It declares intent in S3; each node's agent pulls
images from ECR, manages containers, and programs Caddy. Deploys are idempotent and
nodes self-heal after reboots.

For architecture details, node roles, edge routing, and scaling, see
[`docs/overview.md`](docs/overview.md).

---

## Examples

| Scenario | Directory |
| -------- | --------- |
| First deploy, web + worker, co-located Caddy | [`examples/both-node-web-worker`](examples/both-node-web-worker) |
| Rolling updates (`replicas`, `rollout`) | [`examples/both-node-rolling-replicas`](examples/both-node-rolling-replicas) |
| Dedicated edge, rolling replicas across two app nodes | [`examples/edge-2-app-nodes-rolling-replicas`](examples/edge-2-app-nodes-rolling-replicas) |
| Dedicated edge, multiple envs on one app node (`--env`) | [`examples/edge-1-app-deploy-env-flat-domains`](examples/edge-1-app-deploy-env-flat-domains) |
| `--env` with multi-service domains (`shop.example.com`) | [`examples/edge-1-app-deploy-env-shop-domains`](examples/edge-1-app-deploy-env-shop-domains) |
| Nested env hosts (`ui-<name>.multi.example.com`) | [`examples/edge-1-app-deploy-env-nested-multi-dns`](examples/edge-1-app-deploy-env-nested-multi-dns) |
| Cluster placement (no explicit node names) | [`examples/cluster-2-app-nodes-auto-placement`](examples/cluster-2-app-nodes-auto-placement) |

Full matrix: [`examples/README.md`](examples/README.md).

---

## Development

Monorepo (Node ≥ 24, pnpm 11). From the repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck

# Run the CLI from source
pnpm --filter @agentsystemlabs/launch-pad dev -- deploy --dry-run
```

Packages: `@agentsystemlabs/launch-pad` (CLI),
`@agentsystemlabs/launch-pad-agent` (node reconciler),
`@agentsystemlabs/launch-pad-shared` (Zod schemas / contract).

See [`CLAUDE.md`](CLAUDE.md) for architecture invariants and testing conventions.
