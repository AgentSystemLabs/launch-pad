# Architecture

How Launch Pad works under the hood. The full north-star spec (with end-to-end deploy
walkthroughs and reference wire shapes) is [overview.md](overview.md); this page is the
condensed map.

## The core idea: declarative, no control plane

There is **no server** in the middle. The CLI writes *desired state* to S3; an agent on each
node polls S3 and *reconciles* Docker + Caddy to match. S3 is the only thing the two sides
share:

```
CLI (local) ──writes desired.json──▶ S3 ◀──polls desired.json── agent (on node)
CLI (local) ◀──polls status.json──── S3 ──writes status.json──▶ agent (on node)
```

The CLI never SSHes into nodes to deploy. Deploys are **idempotent** (running the agent
twice against the same desired state is a no-op) and nodes **self-heal** after reboots or
crashes — the next tick reconciles back.

## The three packages

| Package | Role |
| ------- | ---- |
| [`packages/cli`](../packages/cli) (`@agentsystemlabs/launch-pad`) | The product surface. Builds images, pushes to ECR, provisions EC2/IAM, publishes desired state, watches convergence. |
| [`packages/agent-rust`](../packages/agent-rust) | The node reconciler (Rust; role-specific edge/app binaries) — the only thing that touches Docker + Caddy. See [agent.md](agent.md). |
| [`packages/shared`](../packages/shared) | The typed contract. Every shape that crosses the CLI ↔ agent boundary is a Zod schema both sides import — a mismatch becomes a parse error, not a silent hung deploy. |

`PROTOCOL_VERSION` (`shared/src/constants.ts`) versions the wire shape of
`desired.json`/`status.json`. Schema changes must be **additive and backward-compatible**
(new fields use `.default()`) so live nodes keep parsing old documents.

## What a deploy does

1. Load and validate `launch-pad.toml`; enforce the **config lock** against the stored
   baseline (only the operational fields —
   `cpu`/`memory`/`replicas`/`env`/`secrets`/`domain`/`domainPattern` — may change after the first
   deploy; identity/shape is frozen).
2. `docker buildx` for `linux/amd64`; push to ECR under an **immutable content-addressed
   tag** (git SHA / content hash — never `:latest`).
3. **Plan placement** — the scheduler bin-packs services across the cluster's app nodes by
   free CPU/memory, then runs the **capacity admission check**: steady-state demand plus the
   largest single rollout surge must fit each target node (with reserved host headroom).
4. Auto-provision missing nodes — the cluster's dedicated edge plus any app nodes the
   scheduler needs — / resume paused ones / repair EC2 drift (spend-gated:
   `--yes` / `--no-create` / `--dry-run`).
5. Ownership-aware **merge** into each node's `desired.json` (never clobbers other
   projects' services), then a conditional S3 write.
6. Poll `status.json` until every service converges (or `--timeout` expires).

## State layout in S3

One bucket per account+region (`launch-pad-state-<acct>-<region>`); all key derivation
lives in `shared/src/s3-keys.ts`:

```
launch-pad-state-<acct>-<region>/
  nodes/<id>/{node,desired,status}.json   # the implicit `default` cluster (legacy, un-prefixed)
  clusters/<clusterId>/
    cluster.json
    nodes/<id>/{node,desired,status}.json
    nodes/<edge-id>/upstream/<app-node-id>.json   # push-based routing shards
```

State lives under `nodes/` — the machine is the durable identity. The `default` cluster
keeps the legacy un-prefixed root so pre-cluster nodes need no migration.

## Node roles & edge routing

| Role | What runs there |
| ---- | --------------- |
| `edge` | A dedicated Caddy router. Public 80/443 + Elastic IP, no containers. |
| `app` | Containers only. **Private** — no public IP; reachable only by its edge's security group over the VPC. |

Every cluster has exactly **one dedicated edge node** — auto-provisioned as `edge-1`
(default instance type `t3.nano`, `DEFAULT_EDGE_INSTANCE_TYPE` in
`shared/src/constants.ts`) on the first deploy, or chosen via `cluster.json`'s
`defaultEdge` / `cluster set-edge`. Every deploy therefore needs at least **2 nodes**:
the edge + ≥1 app node.

**Push-based routing, never cross-reads:** an `app` agent writes its own *upstream shard*
into its edge's `upstream/` prefix; the `edge` agent reads only its own `upstream/*`. No
node ever reads another node's `desired.json`/`status.json`. This is enforced by
**per-node least-privilege IAM** (`cli/src/aws/iam.ts`): a node can read its own desired
state, write its own status, and (app role) write its shard — nothing else.

Shards are re-published at **every rollout surge/drain step**, and the drain wait is floored
at the edge's poll cadence — otherwise the edge would keep routing to stopped replicas and a
rolling deploy would 502.

## Zero-downtime rolling updates

For each service, one at a time: **surge** a new replica (pull, start, wait for its health
check to pass), add it to routing, then **drain** an old one (remove from routing, wait the
drain timeout, graceful `SIGTERM` stop). Every web service must declare a health check —
it gates surged replicas before they join the load balancer and feeds Caddy's active health
checking, which is what keeps `replicas = 1` rollouts downtime-free.

## Clusters & automatic placement

A **cluster** scopes a group of nodes that share a dedicated edge (and optionally an AWS
account/region via local config). Placement is **fully automatic** — `launch-pad.toml`
carries no node names. The scheduler (`cli/src/deploy/placement.ts`) bin-packs services
across the cluster's app nodes by free CPU/memory, using exactly the admission-check math
so a planned placement can never fail the pre-flight; when the pool is full it
auto-provisions another app node.

A service with `[[service.volumes]]` is **sticky**: the scheduler places all its replicas
on one node and later deploys/rebalances keep it there (its data lives on that node's
disk). If the node lacks capacity for it, that is a hard error — the data can't move — and
draining/evacuating its node is refused.

When placement moves a (volume-free) service between deploys, deploy cleans the vacated
node's `desired.json`; `deploy --restart` pins to the published footprint so a re-plan
can't move services.

## Secrets

`launchpad secret set` writes SecureStrings to SSM Parameter Store under
`/launch-pad/<cluster>/<project>/<service>/<KEY>`. The TOML registers only key names; the
agent resolves values at container start via the node's instance role. Rotation =
`secret set` + `deploy --restart`.

## Observability

- **Logs:** the agent reconciles an Amazon CloudWatch Agent config so container stdout is
  shipped to CloudWatch Logs (`/launch-pad/<cluster>/<project>/<service>` groups,
  `<node>/<replica>` streams). `launchpad logs` merges streams across nodes/replicas.
- **Stats:** the agent samples host + per-container CPU/memory and emits `launchpad.stats`
  lines (~60s) that land in CloudWatch via the system log group. `launchpad node monitor`
  graphs them (historic) or samples live over SSM (`--watch`).
- **Heartbeats:** the agent publishes `status.json` on meaningful change, plus a liveness
  heartbeat every 30s; the CLI flags a node stale after 60s without one.

## Cross-cutting invariants

These are load-bearing — see [`CLAUDE.md`](../CLAUDE.md) for the contributor-facing rules:

1. Wire-schema changes are additive + backward-compatible; bump `PROTOCOL_VERSION` on shape
   changes.
2. The agent stays idempotent and crash-safe.
3. No node ever reads another node's state (push-based shards + least-privilege IAM).
4. Image tags are immutable and content-addressed — never `:latest`.
5. Web services always have health checks; capacity always reserves rollout surge.
