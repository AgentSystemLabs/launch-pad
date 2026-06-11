# Launch Pad — Project Overview

> This is the north-star document. It describes the **end goal** and the **core
> pieces** required to reach it. It is intentionally not a step-by-step plan — new
> features get proposed and built against this document.

## The goal

A developer runs **one command** in their app directory and, with no further work:

1. their entire application is built into a Docker **image**,
2. that image is pushed to **ECR**,
3. **AWS infrastructure to host it is spun up automatically**,
4. the app comes up live on a real domain over HTTPS,
5. and **future pushes update the running app** automatically.

```bash
npx launch-pad deploy
```

That's the whole product. Everything below exists to make that command real and to
keep it real as the app changes.

## The core idea

Launch Pad is built on a **declarative contract** stored in S3, not on a server that
orchestrates deploys.

- The **CLI** publishes *desired state*: "this node should run these services."
- An **agent** on the node continuously *reconciles* reality to match desired state.

The CLI never SSHes in or pushes commands to a machine. It declares intent; the agent
makes it true. S3 is the only thing the two sides share — there is no control-plane
server in the middle (yet).

```
┌─────────┐   writes desired.json    ┌─────────┐   polls desired.json   ┌────────────┐
│   CLI   │ ───────────────────────▶ │   S3    │ ◀───────────────────── │   agent    │
│ (local) │ ◀─────────────────────── │ (state) │ ───────────────────────▶│ (on node)  │
└─────────┘    polls status.json     └─────────┘   writes status.json   └────────────┘
```

This decoupling is the most important design decision: it's why a deploy is just a
file write, why the node self-heals, and why auto-update on new pushes is nearly free.

## Terminology

| Term         | Meaning                                   | Example             |
| ------------ | ----------------------------------------- | ------------------- |
| `node`       | The machine / EC2 VM hosting apps         | `node-prod-1`       |
| `agent`      | The long-running reconciler on the node   | `agent-node-prod-1` |
| `service`    | A user's deployed app / container         | `my-app`            |
| `deployment` | One act of publishing new desired state   | —                   |

Keep `nodeId` and `agentId` separate in code even though there's one agent per node
for now — long-term they diverge. The durable identity users care about is the
**node** ("which machine is my app on?"); the agent is just the worker living on it.

---

## The core pieces

These are the components that must exist. Think of them as the permanent surface area
of the system — features land inside or between these.

### 1. CLI — the product surface (`packages/cli`)

What the user runs locally. This is the entire UX of the product.

- Reads the app's `launchpad.yaml`.
- Builds the Docker image and tags it with an **immutable, content-addressed tag**
  (git SHA / content hash — never `:latest`), so the agent can tell exactly which
  build it's been asked to run.
- Pushes the image to ECR.
- Writes `desired.json` to S3 for the target node.
- Polls `status.json` until the agent confirms the new image is running (or reports
  an error / times out).
- **Auto-provisions** any node a service references but that doesn't exist yet, and
  **resumes** any paused node, before publishing — so the very first deploy works from
  nothing (see *Auto-provisioning on deploy*). Roles are inferred and instance types
  auto-sized from the config; provisioning is spend-gated (`--yes` / `--no-create`).

Commands: `init` · `deploy` · `status` · `node` · `cluster`.

### 2. Agent — the node reconciler (`packages/agent`)

A long-running process on the node. The only thing that touches Docker and Caddy.

- Polls S3 for the node's `desired.json`.
- Diffs desired services against what's actually running.
- Pulls images from ECR, starts/stops/replaces containers (idempotently).
- Updates **Caddy** so each service's `domain` routes to its container — Caddy obtains
  and renews HTTPS certificates automatically.
- Writes `status.json` back to S3 (per-service status + a `lastSeen` heartbeat).
- Keeps local state so it can self-heal after a reboot or crash.

The agent is idempotent and crash-safe: running it twice against the same desired
state does nothing the second time, and it reconciles back to desired state after any
disruption.

### 3. Shared contract (`packages/shared`)

The single source of truth for every shape that crosses the CLI ↔ agent boundary,
validated with **Zod**. Both sides import it so they can never drift. Holds
`DesiredState`, `NodeStatus`, `ServiceConfig`, `DeploymentStatus`, and the
`launchpad.yaml` schema. Drift becomes a parse error instead of a silent hung deploy.

### 4. State store — S3 (the contract at rest)

A single bucket, keyed by node. The only shared medium between CLI and agent.

```
s3://launchpad-state/
  nodes/
    <node-id>/
      desired.json      # written by the CLI, read by the agent
      status.json       # written by the agent, read by the CLI
  projects/
    <footprint>/
      config-baseline.json   # frozen config for the post-deploy config lock
      events/                # append-only deploy history (`launch-pad history`)
```

State lives under `nodes/`, not `agents/`, because the machine is the durable
identity. Per-footprint state (the config-lock baseline and the deploy-history
events) lives under `projects/<footprint>/`. (A named cluster scopes both trees
under `clusters/<id>/`.)

### 5. Provisioning / installer — making nodes exist & be agent-ready (`packages/installer`)

Turns "nothing" into "a node running the agent." For the headline single-command UX,
the CLI must be able to stand up the infra the first time. The pieces it provisions:

- **EC2 instance** — the node. Security group opens 80/443 (Caddy) + 22. Every AWS
  resource the CLI creates (EC2, EBS root volume, Elastic IP, security group, per-node
  IAM role/profile, S3 state bucket, ECR repo) is tagged `launch-pad=true` plus context
  keys (`launch-pad:cluster`, `launch-pad:node`, `launch-pad:role`, etc.) so you can find
  and bill them. Activate **`launch-pad` as a cost allocation tag** in the AWS Billing
  console for Cost Explorer breakdowns.
- **Instance IAM role** — each new node gets a **per-node role** scoped to exact S3 keys:
  read its own `desired.json`, write its own `status.json`, and (for app nodes) publish
  routing shards into its edge's `upstream/` prefix. Edge nodes read only those shards —
  never another agent's desired/registry. ECR pull remains account-wide. With the role,
  the agent needs **no static AWS keys**. Nodes provisioned before this change keep the
  legacy shared `launch-pad-node-role` until recreated.
- **Node bootstrap** (`user_data.sh`) — on boot, installs Docker + Caddy + the agent,
  writes the agent config (`nodeId`, `stateBucket`, `region`), registers the agent as
  a **systemd** service, and starts it. The agent comes back automatically on reboot.
- **ECR repository** for the app's images.
- **S3 state bucket**.
- **DNS** — points the service `domain` at the node so Caddy can issue a real cert.

For the MVP this can start as "generate the bootstrap + create one node mostly by
hand," then graduate into fully automated `launch-pad provision`.

### 6. Example app (`examples/both-node-web-worker`)

A tiny Express app whose only job is to prove every link of the pipeline end to end:
build → ECR push → agent deploy → Caddy routes to it → live HTTPS URL. It's the
fixture every feature is validated against.

---

## How a deploy flows (end to end)

```
CLI                                   S3                         Agent (on the node)
──────────────────────────────────────────────────────────────────────────────────────
read launchpad.yaml
docker build  (immutable tag)
docker push (ECR)
write desired.json  ───────────▶  nodes/<id>/desired.json  ───▶  poll: new desired state
                                                                  docker pull <image>
                                                                  run launchpad-<service>
                                                                  update Caddy (domain→port)
                                                                  Caddy provisions HTTPS
                                  nodes/<id>/status.json  ◀────   write status: running
poll status.json  ◀────────────  (running, image matches)
report success  ✅
```

The CLI's job ends at "publish + watch." The agent's job is "make reality match." The
contract (`packages/shared`) keeps both honest.

## Auto-update on new pushes

This is a first-class goal, and it falls out of the architecture almost for free:

- A new push produces a **new immutable image tag**.
- Re-running the deploy (locally, or from CI on push to the main branch) pushes that
  image and writes an updated `desired.json` pointing at the new tag.
- The agent notices `desired.image != running.image` on its next poll, pulls the new
  image, replaces the container, and re-points Caddy — old container removed.
- `status.json` flips to the new image; the watcher reports success.

So "update on new pushes" = the same deploy path, triggered by CI instead of a human.
A small GitHub Action (or equivalent) that runs `launch-pad deploy` on push is the
intended integration. No special update protocol — just a new desired state.

---

## The contract (reference shapes)

### `desired.json` (CLI → agent)

```json
{
  "version": 1,
  "nodeId": "node-prod-1",
  "services": [
    {
      "serviceId": "my-app",
      "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/my-app:abc123",
      "domain": "my-app.example.com",
      "containerPort": 8080,
      "env": {}
    }
  ]
}
```

### `status.json` (agent → CLI)

```json
{
  "nodeId": "node-prod-1",
  "agentId": "agent-node-prod-1",
  "lastSeen": "2026-06-03T20:30:00Z",
  "services": [
    {
      "serviceId": "my-app",
      "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/my-app:abc123",
      "status": "running",
      "message": "deployed"
    }
  ]
}
```

### `launchpad.yaml` (human-authored, read by the CLI)

The CLI derives `desired.json` from this plus the image it just built/pushed.

```yaml
name: test-app           # becomes serviceId
nodeId: node-dev-1
domain: test.yourdomain.com
containerPort: 3000
```

---

## Repo layout

One monorepo. **Do not split into multiple repos yet** — splitting early slows
everything down.

```
launch-pad/
  docs/
    overview.md           # this document
  packages/
    cli/                  # what the user runs locally — the product surface
    agent/                # what runs on the node — the reconciler
    shared/               # the typed, Zod-validated contract between them
    installer/            # node bootstrap + AWS provisioning
  examples/
    README.md             # matrix of runnable configs & edge cases
    both-node-web-worker/     # the fixture that proves the whole pipeline
```

The clean boundary: **CLI publishes desired state · Agent reconciles the node ·
Shared is the contract · Installer makes nodes (and infra) exist.**

## In scope vs. out of scope

**In scope (the MVP this document targets):** one command that builds, pushes to ECR,
provisions/uses one node, runs one service, serves it on a real domain over HTTPS, and
auto-updates on new pushes.

**Shipped since this MVP framing** (originally listed out of scope, now built): the
multi-node **cluster scheduler** (auto-placement by `schedule`/`topology`),
**health-check-gated zero-downtime rollouts** (described below), the **secrets manager**
(SSM SecureString + `launch-pad secret`), node-local **persistent volumes**
(`[[service.volumes]]` — data survives a container replace), and an experimental local
**dashboard** (`packages/dashboard`).

**Still out of scope:** a hosted **API / control-plane** and managed **web app**, **billing**,
and a central **orchestrator** (the agent is a per-node reconciler, not a central scheduler).
These can be proposed as features later, against this document.

When the monorepo eventually hurts, the natural split is `launch-pad-cli` /
`launch-pad-agent` / `launch-pad-control-plane` — but not before the single-command
flow is solid.

---

## Scaling: replicas, rolling updates & the edge router

> The MVP above (one service, one node, co-located Caddy) shipped. This section
> documents the horizontal-scaling layer built on top of it. Config is TOML
> (`launch-pad.toml`); every field here is optional and backward-compatible.

### Node roles

Each node has a **role** (`launch-pad node create <name> --role …`):

| Role | Runs containers | Runs Caddy | Public ports |
| ---- | --------------- | ---------- | ------------ |
| `both` (default) | yes | yes (co-located) | 80/443 |
| `edge` | no | yes (router) | 80/443 |
| `app` | yes | no | none public — host-port range reachable only by its edge's security group |

`both` is exactly the original co-located behavior. An `edge` node is a dedicated
Caddy router; `app` nodes run only containers and are private (the edge reaches them
over the VPC at `<privateIp>:<hostPort>`).

### Auto-provisioning on deploy

`launch-pad deploy` makes the cluster real *before* it publishes: any node a service
references — a `node`/`nodes` target, or the `edge` that fronts a web service
(including a cluster's `defaultEdge`) — that doesn't exist yet is **created**, and any
node that's **paused** is **resumed**. Then the normal build → push → publish runs. So
you can clone a repo and `launch-pad deploy` straight onto a shared cluster (or onto
nothing) with no separate node-creation step.

- **Roles are inferred** from the config, never restated: a node named as an `edge` →
  `edge`; a node fronted by an edge → private `app`; a node serving a co-located web
  service (no edge) → `both`. A node used as both an edge and an app target → `both`.
- **Instances are auto-sized** to the smallest type that fits the services placed on
  that node (summed cpu/memory × replicas, plus reserved headroom), floor `t3.small`.
  A dedicated edge carries no app load → the floor.
- **Edges are created before app nodes**, because an app node's security group
  references its edge's security group.
- **Spend is gated.** Nodes are billed EC2 on *your* account, so deploy prints the plan
  (create/resume · role · instance type) and asks before provisioning. `--yes` skips
  the prompt and is **required in CI / non-TTY** (where deploy otherwise aborts rather
  than spend silently); `--no-create` keeps the strict behavior (a missing node is an
  error); `--dry-run` prints the plan and provisions nothing.

DNS stays yours to set — point each web domain's A record at its node's (or its edge's)
Elastic IP so Caddy can issue a certificate. A service that targets a whole `cluster`
with **no** app nodes yet still errors: there's no node *name* to create, so name the
node (or pre-create one) to bootstrap an empty cluster.

### Replicas + load balancing

A service declares `replicas` and a placement — a single `node` or a list of `nodes`
(replicas distributed round-robin). Caddy load-balances (round-robin) across all
replicas with **active health checks**, so it never routes to an unhealthy backend.

```toml
[[service]]
name = "web"
nodes = ["app-1", "app-2"]   # 4 replicas → 2 per node
edge  = "edge-1"             # Caddy on edge-1 fronts the domain
replicas = 4
domain = "shop.com"
port = 3000
  [service.healthCheck]
  path = "/healthz"          # a new replica must pass this before an old one drains
  [service.rollout]
  maxSurge = 1               # add one new replica before removing one old
  drainTimeout = "20s"       # stop routing, then let in-flight requests finish
  stopGrace = "30s"          # docker stop --time grace (SIGTERM → grace → SIGKILL)
```

Omit `edge` with a single `node` to keep Caddy co-located (the default).

### Health-gated rolling updates

On an image change the agent rolls one replica at a time: **surge** a new replica →
poll its `/healthz` until 2xx → **add it to the load balancer** → **remove** an old
one from the LB → **drain** for `drainTimeout` → `docker stop --time stopGrace`
(graceful SIGTERM). The invariant — Caddy always keeps ≥1 healthy upstream per domain
— makes deploys zero-downtime (verified: 186/186 requests served `200` across a
live `v1→v2` rollout). Apps should handle `SIGTERM` to drain in-flight work (the
example app does).

**Every web service must declare `[service.healthCheck]`** — the config schema requires
it (workers, which have no `domain`/`port`, do not). It is load-bearing twice over: it
gates a surged replica before it joins the load balancer, *and* it is what Caddy uses for
its own active LB health check. Without it neither guard exists, so even a `replicas = 1`
deploy is no longer zero-downtime — which is why the requirement holds at every replica
count, not just `> 1`. The surge is accounted for automatically: with `maxSurge = 1` a node
transiently runs **one extra replica** during a rollout (for `replicas = 1`, briefly 2×),
and the deploy-time capacity check reserves that headroom — the single largest surge across
the node's services, since a node rolls one service at a time — so a deploy with no room to
surge is rejected up front rather than stalling mid-rollout. Auto-provisioned nodes are
sized for the same peak.

### How the edge learns the cluster

Routing is **push-based**, so no node ever reads another's state. Each **app agent**
builds — from its own `desired.json` plus its live running replicas — an *upstream
shard* (`{ privateIp, backends: [{ domain, hostPort, healthPath }] }`) and writes it
into each edge it serves at `…/nodes/<edge-id>/upstream/<app-node-id>.json`. The
**edge agent** (`role = edge`) lists only its own `upstream/` prefix, unions the shards
per domain, and programs Caddy to round-robin across those healthy replicas over the
VPC (`privateIp:hostPort`) — terminating TLS (Let's Encrypt) for the domains it fronts.

This is exactly what the **per-node least-privilege IAM** (piece 5) buys: an app node
can write only its own shard into its edge's prefix, and an edge can read only its own
`upstream/*` — never another agent's `desired.json`, `status.json`, or registry. No
control-plane server, and no node holds account-wide `nodes/*` read access.

See `examples/README.md` for the full set. Highlights: `both-node-rolling-replicas` (single node,
co-located), `edge-2-app-nodes-rolling-replicas` (edge + replicas across **two** app nodes),
`edge-1-app-deploy-env-flat-domains` (edge + named envs on **one** app node via `--env`),
`edge-1-app-deploy-env-shop-domains` (flat multi-env DNS), `edge-1-app-deploy-env-nested-multi-dns`
(nested `ui-<name>.multi…` + `*.multi` records),
`clusters` (cluster-scoped deploy).

---

## Clusters: scoping & cross-account

> A **cluster** is a named group of nodes that share one VPC, one AWS
> account/region, and one edge router. It's the unit you deploy to *and* the
> isolation boundary. Every field here is optional and backward-compatible — nodes
> created without `--cluster` belong to the implicit `default` cluster and keep the
> legacy S3 layout.

### Why a cluster is the account boundary too

The edge reaches its app nodes over the VPC (`privateIp:hostPort`, with the app
node's security group trusting only the edge's). A shared edge therefore requires a
shared VPC ⟹ one account + region. So "nodes that share an edge" is exactly "nodes
in one account + region" — a cluster. The AWS account is an *attribute* of a cluster
(resolved from local config), giving **1 account : N clusters**: put everything in a
cluster of its own account, or run several clusters in one account.

### Where the pieces live

```
~/.launch-pad/config.toml          # LOCAL: cluster → AWS target (region, profile, roleArn)
        │  resolves the account → bucket
        ▼
launch-pad-state-<acct>-<region>/
  nodes/<id>/…                     # the implicit `default` cluster (legacy layout)
  clusters/
    lower/
      cluster.json                 # { clusterId, defaultEdge, region, … }
      nodes/<id>/{node,desired,status}.json
```

Credentials/accounts live only in local config (consistent with "S3 is the
authoritative registry; `~/.launch-pad` is local prefs"). A cluster's `cluster.json`
holds its **default edge** — so web services route through it automatically.

### Commands

```bash
launch-pad cluster create lower --region us-east-1      # configure target + write cluster.json
launch-pad node create edge-lower --cluster lower --role edge   # first edge → cluster default edge
launch-pad node create app-a      --cluster lower --role app    # --edge defaults to the cluster's edge
launch-pad cluster set-edge lower <node-id>             # change the default edge
launch-pad cluster show lower                           # account, edge, member nodes
launch-pad cluster use lower                            # make `lower` the default for this machine
launch-pad cluster current                             # which cluster am I targeting? (account/region)
launch-pad cluster use default                          # revert to the implicit `default` cluster
```

`cluster use <name>` persists a local `defaultCluster` so `deploy`/`status`/`node …`
target it without `--cluster` every time (like `kubectl config use-context`); AWS-touching
commands then print a `cluster: lower (us-east-1)` line in the banner so you always know
your target. `cluster current` shows the effective cluster — a per-command `--cluster`
still wins, for that invocation only.

Deploy with `--cluster` instead of pinning node names in TOML; the CLI distributes
replicas across the cluster's app nodes and routes the domain through its edge:

```toml
[[service]]
name = "web"
# omit node/nodes — placement comes from deploy --cluster lower
replicas = 4
domain = "app.example.com"
port = 3000
  [service.healthCheck]
  path = "/healthz"
```

```bash
launch-pad deploy --cluster lower
```

Two optional fields steer auto-placement (both only valid when `node`/`nodes` are
omitted, and both locked after the first deploy like every other placement field):

```toml
[[service]]
name = "web"
schedule = "capacity"   # even (default): round-robin · capacity: bin-pack by free CPU/memory
topology = "split"      # auto (default) · split: app nodes behind an edge · co-located: one both-node, local Caddy
replicas = 4
domain = "app.example.com"
port = 3000
  [service.healthCheck]
  path = "/healthz"
```

- `schedule = "even"` is the legacy behavior: round-robin across the cluster's
  app/both nodes. `"capacity"` places each replica on the node with the most free
  CPU/memory (using deploy's own admission math, including rollout-surge headroom)
  and fails with a per-node capacity breakdown when nothing fits.
- `topology = "split"` requires a resolvable edge (`edge = …` or the cluster
  default) even for one node; `"co-located"` puts ALL replicas on a single
  both-role node served by its local Caddy and deliberately ignores the cluster's
  default edge (`edge = …` alongside it is a config error). Workers have no
  ingress: they may use `"co-located"` (one node) but not `"split"`.
- Every deploy prints the resolved placement map (and `placementPlan` under
  `--json`). When a re-plan moves a service off a node, deploy cleans that node's
  desired state; `deploy --restart` always re-rolls in place.

`deploy`, `status`, and the `node` subcommands all take `--cluster` (defaulting to
your local `defaultCluster`, else `default`). Cross-account clusters — a `roleArn`
target assumed per cluster — are the next step (Phase 2); the `default` cluster and
all existing nodes are unaffected. See `examples/cluster-2-app-nodes-auto-placement`,
`examples/cluster-capacity-split`, and `examples/cluster-co-located-single-node` for
runnable configs.

## Logging: application logs in CloudWatch

> Every node ships its containers' stdout/stderr — and its own agent/Caddy logs — to
> **CloudWatch Logs**, so `launch-pad logs <service>` is the primary way to read them.
> This is true **Option A** (agent-based shipping): containers keep Docker's `json-file`
> driver on disk, and the on-box **Amazon CloudWatch Agent** tails those files. The CLI
> never reads logs by node — it reads by *service footprint*.

### What gets shipped & where

The naming scheme is **service-first** — one log group per service footprint
(aggregating every node and replica), with node + replica encoded in the stream name:

```
/launch-pad/<cluster>/<project>/<service>     # one app log group per service footprint
    └── <nodeId>/<replicaIndex>               # one stream per replica (across all nodes)
/launch-pad/<cluster>/system/<nodeId>         # this node's agent (+ caddy on edge/both)
    └── agent | caddy
```

- `<project>` is the **effective** project — with `--env staging` it's `my-app-staging`,
  so an environment's logs land in their own group (matching its container names).
- **Default retention is 7 days**, set on the group the first time the agent writes
  (a constant for now, not yet `launch-pad.toml`-configurable).
- App lines are shipped raw (the Docker `{"log":…}` json wrapper); the CLI unwraps them
  on display.

How it flows: node provisioning installs + starts the CloudWatch Agent with a **base
config** (system logs). On each reconcile, the launch-pad agent renders a **combined
config** mapping every running managed container to its `…-json.log` file and reloads
the CloudWatch Agent. Log shipping is **degraded-safe** — if the CloudWatch Agent is
missing or misconfigured, Docker/Caddy reconcile is unaffected.

### Reading logs

```bash
launch-pad logs api                       # service from launch-pad.toml in cwd
launch-pad logs api --env staging         # the my-app-staging footprint
launch-pad logs api --since 1h --tail 200 # window + last N lines
launch-pad logs api --follow              # stream new lines (Ctrl+C to stop)
launch-pad logs api --filter "error"      # CloudWatch filter pattern
launch-pad logs api --json                # structured output for scripting
```

`logs` reads one group and merges every replica on every node — no `--node` needed.
Default window is the last 15 minutes; `--since` accepts `15m`, `1h`, `24h`, `7d`.

### Operator read access (your local AWS profile)

The node role is granted least-privilege CloudWatch **write** automatically. Reading logs
uses **your** local AWS credentials, which need read access to the cluster's log groups.
A minimal policy (not auto-provisioned in v1):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:<region>:<account>:log-group:/launch-pad/*"
    }
  ]
}
```

### Existing nodes

New nodes get logging automatically at provision time. Nodes created **before** logging
existed need a one-time, idempotent bootstrap — it updates the node's IAM policy and
installs the CloudWatch Agent over SSM:

```bash
launch-pad node install-logging <node>     # one node
launch-pad node install-logging            # every node in the cluster
```

## Monitoring: resource usage over time

> Logs are application output; **monitoring is resource utilization**. Each agent
> samples host + per-container **CPU and memory** every ~60s and emits one
> `launchpad.stats` JSON line to its own stderr, which rides the **existing system-log
> pipeline** to CloudWatch. `launch-pad node monitor <node>` reads those samples back as
> sparkline graphs. This is separate from `status.json` (deploy convergence) — no
> `status.json` change and no `PROTOCOL_VERSION` bump.

### What gets sampled

Each `launchpad.stats` line carries the host (`cpuPercent`, `memoryUsedMb`,
`memoryTotalMb`) and, for `app`/`both` nodes, one entry per running managed container
(`project`, `service`, `replica`, `cpuPercent` as a % of the container's `--cpus` limit,
`memoryUsedMb`, `memoryLimitMb`). `edge` nodes sample host only. Sampling is
**degraded-safe**: a Docker or `/proc` failure can never break a reconcile tick — host
stats still ship, and the per-service array degrades to empty. Two env knobs on the node:

- `LAUNCHPAD_STATS_INTERVAL_MS` — sample cadence (default `60000`; `0` disables sampling).
- `LAUNCHPAD_STATS_SERVICES=0` — host-only (drop the per-service array on tiny nodes).

Lines land in the node's **system** log group (`/launch-pad/<cluster>/system/<nodeId>`,
stream `agent`) — they do **not** pollute `launch-pad logs <service>`, which reads the
per-service app groups.

### Reading usage

```bash
launch-pad node monitor node-prod-1 --since 1h        # historic graph from CloudWatch
launch-pad node monitor node-prod-1 --watch           # live graph via SSM (Ctrl+C to stop)
launch-pad node monitor node-prod-1 --watch --service api   # one service (needs launch-pad.toml)
launch-pad node monitor node-prod-1 --since 1h --watch      # seed history, then go live
launch-pad node monitor node-prod-1 --since 1h --json # { samples: [...] } for scripting
```

- **Historic** (`--since`, default `1h`) reads `launchpad.stats` lines from the system log
  group — no SSM needed, only `logs:FilterLogEvents` (the same read access as `logs`).
- **Live** (`--watch`) samples the node **directly over SSM** every `--interval` seconds
  (default 3) and keeps a `--window` (default `5m`) ring buffer — it does **not** wait on
  log-tail latency. The instance must be running and SSM-managed (the same path
  `node upgrade-agent` / `install-logging` use); your operator profile needs `ssm:SendCommand`.

### When to reach for what

| Need | Command | Source |
| ---- | ------- | ------ |
| App logs for one service | `launch-pad logs <service>` | CW `/launch-pad/.../<project>/<service>` |
| Node CPU/mem history | `launch-pad node monitor <node> --since 1h` | CW system group, `launchpad.stats` lines |
| Node CPU/mem live graph | `launch-pad node monitor <node> --watch` | SSM + local ring buffer |
| Per-service usage | add `--service <name>` | `services[]` in the stats line |
| Deploy health / replicas | `launch-pad status` | S3 `status.json` |
| Allocated vs capacity | `launch-pad node list` | S3 `desired.json` + registry |

The agent reconciles **containers on a live node**; EC2 drift repair (`node reconcile`,
deploy preflight) is a **CLI** concern.
