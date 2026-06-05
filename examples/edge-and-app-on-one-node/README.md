# Example: dedicated edge router + one Express web app

The smallest split topology: a public **edge** runs Caddy; a private **app** node runs
one Express container. HTTPS terminates on the edge and traffic is proxied over the VPC.

```
  app.agentsystem.dev ──────▶ ┌──────────────────────────────┐
                              │  node-edge (role: edge)       │
                              │  Caddy on :443, auto-HTTPS    │
                              └───────────────┬──────────────┘
                                              │ VPC private
                                     ┌────────▼─────────┐
                                     │ node-app (app)   │
                                     │ Express :3000    │
                                     └──────────────────┘
```

## Provision (edge first)

```bash
npx @agentsystemlabs/launch-pad node create node-edge --role edge
npx @agentsystemlabs/launch-pad node create node-app  --role app --edge node-edge
```

Point DNS at the **edge** Elastic IP (`node create node-edge` prints it):

```
app.agentsystem.dev   A   <edge elastic ip>
```

## Deploy

From this directory:

```bash
npx @agentsystemlabs/launch-pad deploy
```

Then:

```bash
curl https://app.agentsystem.dev
```

## Related examples

| Need | Example |
| ---- | ------- |
| Co-located Caddy + web + worker (no separate edge) | [`../both-node-web-worker`](../both-node-web-worker) |
| Rolling replicas across two app nodes | [`../edge-2-app-nodes-rolling-replicas`](../edge-2-app-nodes-rolling-replicas) |
| Multiple deploy environments on one app node | [`../edge-1-app-deploy-env-flat-domains`](../edge-1-app-deploy-env-flat-domains) |

See [`../README.md`](../README.md) for the full examples matrix.
