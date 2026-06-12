# Example: a cluster (auto-placement + shared edge)

A **cluster** is a named group of nodes that share one VPC, one AWS account/region,
and one dedicated edge router. You deploy to the *cluster* — the scheduler picks which
app nodes run your replicas and routes your domain through the cluster's edge. The app's
`launch-pad.toml` stays infra-agnostic — you pass `--cluster` at deploy time, not in the file.

This is the model for "all my lower environments share one edge." Each cluster can
also be its own AWS account (cross-account lands in Phase 2 via a `roleArn` target).

```
                              ┌──────────────────────────────┐
   app.agentsystem.dev ──────▶│  edge-lower (role: edge)      │   cluster: lower
                              │  Caddy on :443, auto-HTTPS    │
                              └───────┬───────────────┬──────┘
                                       │ VPC private   │ VPC private
                              ┌────────▼──────┐ ┌──────▼─────────┐
                              │ app-a         │ │ app-b          │
                              │ web ×2        │ │ web ×2         │
                              │ (role: app)   │ │ (role: app)    │
                              └───────────────┘ └────────────────┘
```

## 1. Create the cluster

```bash
launchpad cluster create lower --region us-east-1
```

This writes the cluster's AWS target to `~/.launch-pad/config.toml` (the only place
accounts/credentials live) and a `cluster.json` in S3 under `clusters/lower/`.

## 2. Add nodes to it

```bash
launchpad node create edge-lower --cluster lower --role edge   # the cluster's one edge
launchpad node create app-a      --cluster lower               # role defaults to "app"
launchpad node create app-b      --cluster lower               # --edge defaults to the cluster edge
```

Every cluster has exactly ONE dedicated edge node running Caddy; app nodes are
VPC-private behind it. (You can also skip pre-creating nodes entirely — a first
`deploy` on an empty cluster auto-provisions `edge-1` + `app-1`.)

Point the domain's A record at the edge's Elastic IP (shown by `node create edge-lower`):

```
app.agentsystem.dev   A   <edge-lower elastic ip>
```

## 3. Deploy into the cluster

```bash
launchpad deploy --cluster lower
```

The scheduler distributes the service's 4 replicas across `lower`'s app nodes (2 on
each when both have headroom), records that the cluster's edge fronts
`app.agentsystem.dev`, and the edge agent load-balances the domain across every
running, healthy replica — obtaining a Let's Encrypt cert. Inspect the cluster with:

```bash
launchpad cluster show lower      # account, edge, member nodes
launchpad status --cluster lower  # per-node service health
```

## Notes

- **State isolation:** a named cluster's S3 state lives under
  `clusters/lower/nodes/…`. The implicit `default` cluster (everything created
  without `--cluster`) keeps the legacy `nodes/…` layout, so pre-cluster nodes need
  no migration.
- **Placement is always automatic:** there are no `node`/`edge` fields in the TOML —
  the scheduler owns placement, and `launchpad rebalance` can redistribute later.
- **Named envs behind the same edge:** see `examples/edge-1-app-deploy-env-flat-domains`
  for `deploy --env <name>` footprints sharing the cluster's app pool.
