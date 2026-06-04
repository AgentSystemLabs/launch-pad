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
- Can **provision** the AWS infrastructure a node needs (see piece 5) so the very
  first deploy works from nothing.

Commands: `init` · `provision` · `deploy` · `status`.

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
      events/           # optional append-only deploy history (later)
```

State lives under `nodes/`, not `agents/`, because the machine is the durable
identity.

### 5. Provisioning / installer — making nodes exist & be agent-ready (`packages/installer`)

Turns "nothing" into "a node running the agent." For the headline single-command UX,
the CLI must be able to stand up the infra the first time. The pieces it provisions:

- **EC2 instance** — the node. Security group opens 80/443 (Caddy) + 22.
- **Instance IAM role** — grants the node S3 access to `nodes/<id>/*` and ECR pull.
  With the role, the agent needs **no static AWS keys**.
- **Node bootstrap** (`user_data.sh`) — on boot, installs Docker + Caddy + the agent,
  writes the agent config (`nodeId`, `stateBucket`, `region`), registers the agent as
  a **systemd** service, and starts it. The agent comes back automatically on reboot.
- **ECR repository** for the app's images.
- **S3 state bucket**.
- **DNS** — points the service `domain` at the node so Caddy can issue a real cert.

For the MVP this can start as "generate the bootstrap + create one node mostly by
hand," then graduate into fully automated `launch-pad provision`.

### 6. Example app (`examples/node-express-app`)

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
    node-express-app/     # the fixture that proves the whole pipeline
```

The clean boundary: **CLI publishes desired state · Agent reconciles the node ·
Shared is the contract · Installer makes nodes (and infra) exist.**

## In scope vs. out of scope

**In scope (the MVP this document targets):** one command that builds, pushes to ECR,
provisions/uses one node, runs one service, serves it on a real domain over HTTPS, and
auto-updates on new pushes.

**Deliberately out of scope for now:** dashboard · API / control-plane · web app ·
billing · multi-node scheduler · orchestrator · health-check-gated zero-downtime
rollouts · secrets manager. These can be proposed as features later, against this
document.

When the monorepo eventually hurts, the natural split is `launch-pad-cli` /
`launch-pad-agent` / `launch-pad-control-plane` — but not before the single-command
flow is solid.
