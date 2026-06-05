# Example: a cluster (auto-placement + shared edge)

A **cluster** is a named group of nodes that share one VPC, one AWS account/region,
and one edge router. You deploy to the *cluster* — the CLI picks which app nodes run
your replicas and routes your domain through the cluster's edge. The app's
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
launch-pad cluster create lower --region us-east-1
```

This writes the cluster's AWS target to `~/.launch-pad/config.toml` (the only place
accounts/credentials live) and a `cluster.json` in S3 under `clusters/lower/`.

## 2. Add nodes to it

```bash
launch-pad node create edge-lower --cluster lower --role edge   # becomes the default edge
launch-pad node create app-a      --cluster lower --role app    # --edge defaults to edge-lower
launch-pad node create app-b      --cluster lower --role app
```

The first `edge`/`both` node created in a cluster automatically becomes its default
edge. Change it any time with `launch-pad cluster set-edge lower <node-id>`.

Point the domain's A record at the edge's Elastic IP (shown by `node create edge-lower`):

```
app.agentsystem.dev   A   <edge-lower elastic ip>
```

## 3. Deploy into the cluster

```bash
launch-pad deploy --cluster lower
```

The CLI distributes the service's 4 replicas across `lower`'s app nodes (2 on each),
records that the cluster's edge fronts `app.agentsystem.dev`, and the edge agent
load-balances the domain across every running, healthy replica — obtaining a Let's
Encrypt cert. Inspect the cluster with:

```bash
launch-pad cluster show lower      # account, edge, member nodes
launch-pad status --cluster lower  # per-node service health
```

## Notes

- **State isolation:** a named cluster's S3 state lives under
  `clusters/lower/nodes/…`. The implicit `default` cluster (everything created
  without `--cluster`) keeps the legacy `nodes/…` layout, so pre-cluster nodes need
  no migration.
- **Explicit nodes still work:** see `examples/edge-2-app-nodes-rolling-replicas` for pinning specific
  `nodes` + `edge` names instead of cluster auto-placement.
- **Named envs on one app node:** see `examples/edge-1-app-deploy-env-flat-domains` for a dedicated edge
  with `deploy --env <name>` on a single app node.
