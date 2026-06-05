# Feature Plan — Clusters (scoping + cross-account)

> Status: **Phase 1 code-complete + green** (74 unit tests, typecheck clean, CLI
> smoke verified; not yet live-verified on real EC2). **Phase 2 (cross-account
> assume-role) is scaffolded but gated off** — local config accepts
> `roleArn`/`externalId` (`packages/cli/src/config/local.ts`), but `prepareAws`
> rejects it with a "not supported yet" error (`packages/cli/src/aws/context.ts`)
> and `cluster create` warns; activation is still to come. Companion to
> `docs/overview.md` and `docs/env-deploys-plan.md`. This plan adds a **cluster**
> abstraction: a named deploy scope that bundles nodes together behind one shared
> edge, can be deployed to as a unit, and can be backed by its own AWS account.

## Motivation

Today a service in `launch-pad.toml` targets raw node ids (`node` / `nodes`) and
names a raw `edge`. There's no way to say "all my lower environments share one
edge router; deploy this to the *lower* cluster" — and no way to put one cluster
in a separate AWS account for isolation.

We want:

1. **Clustering** — bundle several nodes (e.g. `dev-app` + `staging-app` + a
   shared `edge`) under one name.
2. **Shared edge per cluster** — every web service in the cluster routes through
   the cluster's edge automatically.
3. **Deploy-to-cluster** — `launch-pad.toml` says `cluster = "lower"`; the CLI
   resolves placement and the edge from the cluster.
4. **Account scoping** — a cluster may live in its own AWS account (and/or
   region), fully isolated (separate bucket, IAM, ECR, edge).

## Why "cluster" (and why one concept, not two)

Two axes hide in the requirement:

- **Isolation / account boundary** — *where* infra lives (same vs. separate AWS
  account); about credentials, billing, blast radius.
- **Logical scope** — *what's grouped* (dev + staging together, prod apart).

Normally those are distinct concepts. For launch-pad they **collapse into one**,
because of the edge constraint:

- `buildEdgeBackends` (`packages/shared/src/edge.ts`) dials app nodes at
  `privateIp:hostPort` — VPC-private routing.
- An app node's security group opens its host-port range **only to the edge's
  security group** via `UserIdGroupPairs` (`packages/cli/src/aws/ec2.ts`) — a
  same-VPC SG-to-SG reference.

A shared edge therefore ⟹ one VPC ⟹ one account + region. You *cannot* share an
edge across accounts. So "the set of nodes that share an edge" is exactly "the set
of nodes in one account+region." That unit is a **cluster**:

> **A cluster = a named set of nodes sharing one edge + one VPC + one account /
> region + one state scope.** It is both the deploy target and the isolation
> boundary. The AWS account is an *attribute* of a cluster (resolved from local
> creds), not a separate managed object.

Both scenarios fall out of the one primitive:

- Whole infra in its own account → **one cluster = one account.**
- Multiple environments in one account, separated → **N clusters in one account**
  (each its own edge/VPC, isolated by an S3 prefix). So **1 account : N clusters.**

There is **one vocabulary**: `cluster`. The old internal `fleet` term (which meant
"the set of nodes an edge aggregates" — exactly a cluster's app nodes as seen by its
edge) has been renamed so public and internal code don't drift: `fleet.ts → edge.ts`,
`FleetNode → ClusterNode`, `FleetBackend → EdgeBackend`. (`buildEdgeBackends` and
`EdgeConfig` were already edge-named and kept.)

## Locked decisions

- **Name:** `cluster` everywhere — one vocabulary, public and internal. The old
  `fleet` term was renamed out (`fleet.ts → edge.ts`, `FleetNode → ClusterNode`,
  `FleetBackend → EdgeBackend`).
- **Both phases** in scope: logical clusters (single account) **and** cross-account.
- **A cluster has a `defaultEdge`** (in `cluster.json`). Web services in the
  cluster route through it automatically; `launch-pad.toml` only names the cluster.
- **Environment stays emergent** — no `environment` object. dev vs. staging is
  expressed by domains (`dev.shop.com`) and node names. Revisit only if env-level
  config inheritance is ever needed.
- Credentials/accounts live **only in local config** (`~/.launch-pad/…`),
  consistent with the rule that `~/.launch-pad` is local prefs and S3 is the
  authoritative registry.
- The **`default` cluster maps to the legacy un-prefixed `nodes/` path** — no
  migration of the live `node-prod-1` required.

## Target shapes

### Local config — `~/.launch-pad/config.toml` (NEW; the only place accounts live)

```toml
defaultCluster = "lower"        # used when --cluster is omitted

[clusters.lower]                # same account as ambient creds → logical cluster
profile = "default"
region  = "us-east-1"

[clusters.prod]                 # a DIFFERENT AWS account
roleArn     = "arn:aws:iam::222222222222:role/launch-pad-deployer"
region      = "us-east-1"
# optional: profile (base creds to assume from), externalId, sessionName
```

### `cluster.json` — `clusters/<clusterId>/cluster.json` (NEW; authoritative topology)

```jsonc
{
  "clusterId": "lower",
  "defaultEdge": "edge-lower",   // nullable until an edge is created
  "region": "us-east-1",
  "createdAt": "…",
  "createdBy": "arn:aws:sts::…"
}
```

### S3 layout

```
launch-pad-state-<acct>-<region>/
  nodes/<id>/…                      ← legacy = the implicit "default" cluster (unchanged)
  clusters/
    lower/
      cluster.json
      nodes/edge-lower/{node,status,edge}.json
      nodes/dev-app/{node,desired,status}.json
      nodes/staging-app/{node,desired,status}.json
    prod/                           ← may instead live in account 222's bucket
      cluster.json
      nodes/…
```

### `launch-pad.toml` — service targets a cluster

```toml
[[service]]
name  = "web"
cluster = "lower"      # CLI picks nodes in the cluster + the cluster's defaultEdge
replicas = 4
domain = "dev.shop.com"
port = 3000
  [service.healthCheck]
  path = "/healthz"
```

`cluster` is an alternative to `node` / `nodes`. Explicit `node`/`nodes` still
work (resolved within the named cluster). `edge` may be omitted — it defaults to
the cluster's `defaultEdge`, resolved at deploy time.

---

## Changes by package

### `packages/shared`

| File | Change |
|---|---|
| `s3-keys.ts` | Add `clusterPrefix(clusterId)`, `clusterConfigKey(clusterId)`. Thread `clusterId` into `nodePrefix`/`desiredKey`/`statusKey`/`nodeRegistryKey`/`edgeConfigKey`. **Rule:** `clusterId === "default"` → legacy root (`nodes/<id>/`); any named cluster → `clusters/<c>/nodes/<id>/`. Keep `NODES_PREFIX` for the default path. |
| `cluster.ts` (NEW) | `ClusterConfigSchema` + `parseClusterConfig` (`clusterId`, `defaultEdge: nullable().default(null)`, `region`, `createdAt`, `createdBy`). |
| `registry.ts` | Add `clusterId: z.string().default("default")` to `NodeRegistryEntrySchema` (default keeps pre-cluster `node.json` parsing). |
| `config.ts` | Add `cluster: z.string().optional()` to `ServiceDeclSchema`. Update `superRefine`: exactly one of `cluster` \| `node` \| `nodes`. When `cluster` is set, **skip** the "multi-node web needs an edge" check (the edge is resolved later from `cluster.json`) and allow `edge` to be omitted. Add a `targetCluster(decl)` helper. |
| `index.ts` | Export the new `cluster` module + key helpers. |

`desired.ts` / `status.ts` are **unchanged** — `ingress.edge` already carries the
*resolved* edge node id. The CLI resolves cluster → edge before writing
`desired.json`, so the on-the-wire contract doesn't move. The cluster is implied
by the object's S3 location.

### `packages/agent`

| File | Change |
|---|---|
| `config.ts` | Add `clusterId: z.string().default("default")` to `AgentConfigSchema`. Pre-cluster `agent.json` (no `clusterId`) parses as `default` → legacy keys → the live node keeps working. |
| `s3.ts` | `listNodeIds`, `getNodeRegistry`, `getDesiredFor`, `getNodeStatusFor`, `putStatus` take/derive the cluster prefix from `config.clusterId`. |
| `edge.ts` | `listNodeIds(... config.clusterId)` so an edge only ever sees nodes **in its own cluster** (the prefix already enforces this; for the `default` cluster it lists the root as before). Consumes the renamed `ClusterNode` type from shared. |

The reconcile / Caddy / rollout / health machinery is untouched — it's per-node.

### `packages/cli`

| File | Change |
|---|---|
| `config/local.ts` (NEW) | Read/write `~/.launch-pad/config.toml`: `loadLocalConfig()`, `resolveClusterTarget(clusterId)` → `{ profile?, roleArn?, region, externalId?, sessionName? }`, `defaultCluster`. |
| `aws/context.ts` (`prepareAws`) | Become **cluster-aware**. Resolve `clusterId` (`--cluster` → `defaultCluster` → `"default"`). Build credentials: `profile` → `fromIni`; `roleArn` → `fromTemporaryCredentials` (base creds ambient or from `profile`). Build STS/S3/EC2/ECR/IAM/SSM with those creds + the cluster's region. `sts:GetCallerIdentity` → accountId → `stateBucketName`. Add `clusterId` to `AwsEnv`. The `default` cluster with no config entry falls back to today's ambient-credentials behavior (full backcompat). |
| `commands/cluster/index.ts` (NEW) | `cluster create <name> --region --profile/--role-arn [--edge <id>]` (writes local config, ensures bucket, writes `cluster.json`); `cluster list`; `cluster show <name>`; `cluster set-edge <name> <nodeId>`. |
| `commands/node/index.ts` | `--cluster <c>` on every subcommand. `create` writes the node under the cluster prefix and sets `entry.clusterId`; when `--role app` and the cluster has a `defaultEdge`, `--edge` defaults to it. `list`/`show`/`destroy`/`pause`/`resume` operate within the resolved cluster. |
| `commands/deploy.ts` | Resolve each service's cluster (decl `cluster`, else `--cluster`, else `default`). Load `cluster.json`; default `ingress.edge` to `cluster.defaultEdge`. Write `desired.json` under the cluster prefix. Build + push to the **resolved account's** ECR (automatic once `prepareAws` uses cluster creds). |
| `commands/status.ts` | `--cluster <c>`; read status under the cluster prefix. |
| `deploy/placement.ts` | When a service uses `cluster` (no explicit nodes), resolve candidate nodes = the cluster's app/both nodes, then distribute replicas (reuse round-robin; capacity-aware bin-pack is a follow-up). Add a **same-cluster-edge** validation: a service's resolved `edge` must belong to the same cluster as its app nodes (cross-cluster edge = `CliError`). |

---

## Cross-account specifics (Phase 2)

1. **Credentials** — per-cluster `roleArn` (assume-role via
   `fromTemporaryCredentials`) or `profile` (`fromIni`). This is the bulk of the
   new code. Everything downstream (`ensureBucket`, `ensureNodeRole`, ECR push,
   `RunInstances`) then transparently targets the resolved account because the
   clients carry its creds.
2. **ECR** — `prepareAws` resolving the target account means images push to *that
   account's* ECR automatically. **First cut: push per target.** Follow-up option:
   one shared repo with a cross-account repository policy + the app node pull role
   allowing it (cheaper storage, more IAM) — documented, not built initially.
3. **IAM node role** — `ensureNodeRole` already runs per-account; with cluster
   creds it's created in the target account. The cluster's creds need
   `iam:CreateRole` etc.
4. **DNS** — one A-record per edge EIP: `*.dev.shop.com → edge-lower`,
   `shop.com → edge-prod`. Unchanged from today, just one set per cluster.
5. **Network invariant** — enforce that a service's edge is in the **same
   cluster** as its app nodes; a cross-cluster/account edge can't route over the
   VPC and must be a config error.

---

## Backward compatibility

- `default` cluster ⇒ legacy un-prefixed `nodes/<id>/` keys. The live
  `node-prod-1` and the `edge-2-app-nodes-rolling-replicas` demo keep working with **no migration**.
- `NodeRegistryEntry.clusterId` and `AgentConfig.clusterId` both
  `default("default")`, so pre-cluster `node.json` / `agent.json` parse unchanged.
- `default` cluster with no local-config entry ⇒ today's ambient-credentials path.
- Extend `packages/shared/src/backcompat.test.ts`: legacy `node.json` parses as
  `default`; legacy key paths still resolve; a named cluster yields the prefixed
  path.

## Test strategy

- **shared** — `s3-keys` cluster-prefix + default-legacy cases; `cluster.ts`
  schema; `config.ts` `cluster`-vs-`node`/`nodes` exclusivity + edge-optional-with-
  cluster; backcompat.
- **cli** — `placement` within a cluster; `prepareAws` cluster resolution with
  mocked STS/credential providers (profile + assume-role); `deploy` resolving
  `ingress.edge` from `cluster.json`; same-cluster-edge validation error.
- **agent** — `edge.ts` lists only its cluster's prefix (default vs named).

## Phased rollout

### Phase 1 — logical clusters, single account ✅ DONE (code-complete + green)
1. **shared:** `clusterId` on registry + agent config (defaults), `s3-keys`
   cluster prefix (default→legacy), `ClusterConfigSchema`, `config.ts` `cluster`
   field + refinements.
2. **cli:** local-config reader, cluster-aware `prepareAws` (still ambient creds
   for `default`), `cluster create/list/show/set-edge`, `node create --cluster`,
   `deploy`/`status` cluster-scoped, placement-within-cluster, edge default from
   `cluster.json`.
3. **agent:** `clusterId` in config; `s3.ts` + `edge.ts` cluster-scoped listing.
4. **example + docs:** update `examples/edge-2-app-nodes-rolling-replicas` to a `cluster`; add a
   Clusters section to `docs/overview.md`.

**Checkpoint:** create a `lower` cluster in your current account, `node create`
`edge-lower` + `dev-app` + `staging-app` into it, deploy a service with
`cluster = "lower"` and confirm the shared edge fronts it (extends the verified
edge-2-app-nodes-rolling-replicas demo).

### Phase 2 — cross-account 🚧 SCAFFOLDED (gated off — config shape exists, resolution not wired)
5. **cli:** per-cluster `profile`/`roleArn` resolution in `prepareAws`
   (assume-role), STS caller identity → bucket per account.
6. **ECR:** per-target push works for free; document the shared-repo option.
7. **validation:** same-cluster-edge rule at deploy.
8. **docs + example:** a two-account walkthrough (`lower` in account A, `prod` in
   account B).

**Checkpoint:** stand up a `prod` cluster in a second AWS account with its own
bucket, IAM, edge + EIP, fully isolated from `lower`.

## Open questions

- **Capacity-aware placement** when `cluster` resolves to multiple app nodes —
  round-robin first; bin-pack against allocatable capacity as a follow-up.
- **Shared ECR vs per-account ECR** as the long-term cross-account default.
- **Org-above-clusters?** If you later want to group several clusters/accounts
  under an "org" for billing/overview, it sits *above* clusters — premature now,
  but the cluster primitive doesn't preclude it.
