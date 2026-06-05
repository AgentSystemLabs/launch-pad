# Example: dedicated edge + `--env` on one app node

One **edge** node fronts HTTPS for every environment. Each `deploy --env <name>` run
gets an isolated footprint on the same **app** node — no config edits per environment.

```
  <name>.agentsystem.dev ──────┐
  api-<name>.agentsystem.dev ──┤    ┌──────────────────────────────┐
                                ├───▶│  node-edge (role: edge)     │
                                │    │  Caddy :443, auto-HTTPS       │
                                │    └───────────────┬──────────────┘
                                │                    │ VPC private
                                │           ┌────────▼─────────┐
                                │           │ node-app (app)   │
                                │           │ edge-env-<name>/*│
                                │           └──────────────────┘
```

## Provision (edge first)

```bash
npx @agentsystemlabs/launch-pad node create node-edge --role edge
npx @agentsystemlabs/launch-pad node create node-app  --role app --edge node-edge
```

Point DNS at the **edge** Elastic IP (`node create node-edge` prints it):

```
*.agentsystem.dev   A   <edge elastic ip>   # api-<name>.*, <name>.*, …
app.agentsystem.dev A   <edge elastic ip>   # production web anchor
```

## Deploy environments

From this directory:

```bash
npx @agentsystemlabs/launch-pad deploy --env preview
npx @agentsystemlabs/launch-pad deploy --env qa
```

- **Domains** come from `domainPattern` (project default for `api`, per-service for `web`).
- **Footprints** are namespaced: `edge-env-preview` and `edge-env-qa` containers coexist on `node-app`.
- **Same edge:** each env only adds routes on `node-edge`; the app agent pushes upstream shards per env.
- **Status:** `launch-pad status --env preview` scopes to that footprint.

CI can run `deploy --env "$ENV"` with no TOML changes. Production uses the literal domains in the TOML:

```bash
npx @agentsystemlabs/launch-pad deploy   # app.agentsystem.dev + api.agentsystem.dev
```

## Related examples

| Need | Example |
| ---- | ------- |
| Rolling replicas across **two** app nodes (explicit `nodes`) | [`edge-2-app-nodes-rolling-replicas`](../edge-2-app-nodes-rolling-replicas) |
| `--env` with fictional `shop.example.com` hosts | [`edge-1-app-deploy-env-shop-domains`](../edge-1-app-deploy-env-shop-domains) |
| Nested `ui-<name>.multi.agentsystem.dev` + `*.multi` DNS | [`edge-1-app-deploy-env-nested-multi-dns`](../edge-1-app-deploy-env-nested-multi-dns) |
| Cluster auto-placement (no `node`/`edge` names) | [`cluster-2-app-nodes-auto-placement`](../cluster-2-app-nodes-auto-placement) |

See [`../README.md`](../README.md) for the full examples matrix.
