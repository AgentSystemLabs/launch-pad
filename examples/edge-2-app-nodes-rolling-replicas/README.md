# Example: dedicated edge router + cross-node rolling replicas (3 nodes)

A dedicated **edge** node fronts two **app** nodes, demonstrating the Caddy router
living on its own box and load-balancing replicas across the cluster.

```
                              ┌──────────────────────────────┐
  app.agentsystem.dev ───────▶│  node-edge (role: edge)       │
                              │  Caddy on :443, auto-HTTPS    │
                              └───────┬───────────────┬──────┘
                                       │ VPC private   │ VPC private
                              ┌────────▼──────┐ ┌──────▼─────────┐
                              │ node-app-a    │ │ node-app-b     │
                              │ web ×2        │ │ web ×2         │
                              │ (role: app)   │ │ (role: app)    │
                              └───────────────┘ └────────────────┘
```

App nodes have **no public ingress** — their host-port range is reachable only by
the edge's security group, over the VPC. Only the edge is public (80/443).

## Provision (order matters — the edge must exist first)

```bash
npx @agentsystemlabs/launch-pad node create node-edge    --role edge
npx @agentsystemlabs/launch-pad node create node-app-a   --role app --edge node-edge
npx @agentsystemlabs/launch-pad node create node-app-b   --role app --edge node-edge
```

Point the domain's A record at the **edge's** Elastic IP (shown by `node create node-edge`):

```
app.agentsystem.dev   A   <edge elastic ip>
```

## Deploy

```bash
npx @agentsystemlabs/launch-pad deploy
```

The CLI builds one image, places 4 replicas round-robin across both app nodes, and
records that the edge fronts the domain. The edge agent programs Caddy to round-robin
to every running, healthy replica — obtaining a Let's Encrypt cert. Then:

```bash
curl https://app.agentsystem.dev
```

`launch-pad node show node-edge` lists the edge's routes and upstream counts.

For **named environments on one app node** (via `deploy --env`), see
[`../edge-1-app-deploy-env-flat-domains`](../edge-1-app-deploy-env-flat-domains).

## Rolling updates still apply

Bump `RELEASE` in `../both-node-web-worker/server.js` and re-deploy — each app node rolls
its replicas one at a time (health-gated, drained, gracefully stopped) while the edge
keeps routing to the healthy ones. Zero downtime, across nodes.

## Save money

`launch-pad node pause <name>` stops any of the three instances (Elastic IPs persist);
`node resume` brings it back. `node destroy node-app-a` / `node-app-b` first, then
`node destroy node-edge` (the edge's SG can't be deleted while app nodes reference it).
