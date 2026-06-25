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

### External (BYOS) nodes

A node can be either a managed EC2 instance Launch Pad provisions, or an **operator-owned
host** you bring yourself (BYOS). The registry entry (`shared/src/registry.ts`) records this
as `provisioning: "ec2" | "external"`. [`node init`](cli.md#node-init) enrolls one: it
provisions only AWS credentials, SSHes in once to bootstrap, and writes an `external` registry
entry — no EC2 is ever created. App hosts install Docker and publish upstream shards; edge
hosts install Caddy and reconcile routes from those shards.

**Reaching an app box (`advertiseIp`).** An EC2 app node advertises its VPC `privateIp` to the
edge; an external box has no such address Launch Pad controls, so it advertises an
**`advertiseIp`** — the IP the edge dials to reach the box's container host ports. `node init`
auto-detects this from the host's default IPv4 route over SSH when the flag is omitted, then
asks the operator to confirm; passing `--advertise-ip` overrides detection for VPN/VPC/peered
addresses. The agent resolves it in priority order: env `LAUNCHPAD_ADVERTISE_IP` →
`agent.json`'s `advertiseIp` → the host's IMDS private IP. `advertiseIp` is stored in **both**
`agent.json` (so the agent embeds it in its shard) and `node.json` (so the CLI sees it).
External nodes leave
`instanceId`, `securityGroupId`, `iamInstanceProfile`, `availabilityZone`, `privateIp`, and
`eipAllocationId` **null** — there is no EC2 resource behind them. External edge nodes omit
`advertiseIp` and instead record the stable, operator-managed `publicIp` users point DNS at.

**Credentials: IAM user vs. instance profile.** An EC2 node authenticates via its **instance
profile** (the agent picks up role credentials from IMDS). An external box has no instance
profile, so `node init` creates a per-node IAM **user** with the *same* least-privilege node
policy — `buildAppPolicy` / `buildEdgePolicy` via `buildNodePolicy` in `cli/src/aws/iam.ts`,
identical scope to the EC2 path: read its own `desired.json`, write its own `status.json`,
(app) write its upstream shard, ECR pull account-wide, SSM secrets for its services. The
access key is created once and written to `/etc/launch-pad/agent.env` on the box (loaded by
the systemd unit's `EnvironmentFile`). `node destroy` deletes that IAM user (keys + policy)
and the S3 prefix, and makes **no EC2 calls** — the host is yours to tear down.

**Operator responsibilities (the FR-7 networking contract).** Because Launch Pad doesn't own
the box's network, the operator must satisfy what auto-provisioning would otherwise guarantee:

- **App nodes** — the edge must be able to reach `advertiseIp` over **TCP 20000–29999** (the
  container host-port range, `HOST_PORT_MIN`..`HOST_PORT_MAX`), or routed traffic and active
  health checks fail. A NAT **hairpin** (edge and box behind the same NAT, dialing the box's
  public IP) commonly breaks health checks — advertise an address the edge can reach directly
  (a private/VPC IP or a peered address).
  `node init` best-effort verifies this by opening a one-shot listener on TCP 20000 over SSH
  and asking the EC2 edge to connect over SSM; `doctor` probes live external host ports once a
  web service is running.
- **Edge nodes** — must expose public **80/443**, have **DNS** pointing at the stable
  `--public-ip` recorded in `node.json`, and put **no CDN/proxy in front** of the ACME
  HTTP/TLS challenges (Caddy's Let's Encrypt issuance requires the domain to resolve directly
  to the box).
- **Secrets & images** — the app box needs outbound **HTTPS to SSM and ECR** in the cluster's
  region to resolve secrets and pull images.

No `PROTOCOL_VERSION` bump was needed: the new registry fields are additive (`.default()`),
and `node.json` is CLI-side state the agent doesn't parse — the only wire-visible addition,
`advertiseIp` in `agent.json`, is an optional field old documents simply lack.

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

- **Logs:** the agent tails Docker json-file logs and its forwarded system log files, then
  writes batches directly to CloudWatch Logs (`/launch-pad/<cluster>/<project>/<service>`
  groups, `<node>/<replica>` streams). `launchpad logs` merges streams across nodes/replicas.
- **Stats:** the agent samples host + per-container CPU/memory and emits `launchpad.stats`
  lines (~60s) that land in CloudWatch via the system log group. `launchpad node monitor`
  graphs them (historic), samples EC2 nodes live over SSM (`--watch`), or polls an external
  node's `status.json.host` heartbeat sample when SSM is unavailable.
- **Heartbeats:** the agent publishes `status.json` on meaningful change, plus a liveness
  heartbeat every 30s; the CLI flags a node stale after 60s without one.

BYOS Phase 1 note: external app nodes do not need the separate CloudWatch Agent; `node init`
installs a tiny journald forwarder and the Rust agent ships service + agent logs through the
same CloudWatch Logs groups as EC2 nodes. External nodes also carry `instanceType: "external"`
for registry purposes but are not counted as EC2 compute in cost rollups; only their agent S3
polling is estimated.

## Cross-cutting invariants

These are load-bearing — see [`CLAUDE.md`](../CLAUDE.md) for the contributor-facing rules:

1. Wire-schema changes are additive + backward-compatible; bump `PROTOCOL_VERSION` on shape
   changes.
2. The agent stays idempotent and crash-safe.
3. No node ever reads another node's state (push-based shards + least-privilege IAM).
4. Image tags are immutable and content-addressed — never `:latest`.
5. Web services always have health checks; capacity always reserves rollout surge.
