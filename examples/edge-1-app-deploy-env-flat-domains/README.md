# Example: shared edge + `--env` environments

The cluster's **edge** node fronts HTTPS for every environment. Each `deploy --env <name>`
run gets an isolated footprint on the cluster's **app** node(s) — no config edits per
environment, and no infrastructure names in the TOML.

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

## Provision (edge first — or let deploy auto-provision)

```bash
npx @agentsystemlabs/launch-pad node create node-edge --role edge
npx @agentsystemlabs/launch-pad node create node-app  --edge node-edge   # role defaults to "app"
```

Skipping this is fine: a first `deploy` on an empty cluster auto-provisions
`edge-1` + `app-1`.

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
- **Footprints** are namespaced: `edge-env-preview` and `edge-env-qa` containers coexist
  on the cluster's app node(s).
- **Same edge:** each env only adds routes on the edge; the app agent pushes upstream shards per env.
- **Status:** `launchpad status --env preview` scopes to that footprint.

CI can run `deploy --env "$ENV"` with no TOML changes. Production uses the literal domains in the TOML:

```bash
npx @agentsystemlabs/launch-pad deploy   # app.agentsystem.dev + api.agentsystem.dev
```

## Related examples

| Need | Example |
| ---- | ------- |
| Rolling replicas across **two** app nodes | [`edge-2-app-nodes-rolling-replicas`](../edge-2-app-nodes-rolling-replicas) |
| `--env` with fictional `shop.example.com` hosts | [`edge-1-app-deploy-env-shop-domains`](../edge-1-app-deploy-env-shop-domains) |
| Nested `ui-<name>.multi.agentsystem.dev` + `*.multi` DNS | [`edge-1-app-deploy-env-nested-multi-dns`](../edge-1-app-deploy-env-nested-multi-dns) |
| Named cluster auto-placement (`deploy --cluster`) | [`cluster-2-app-nodes-auto-placement`](../cluster-2-app-nodes-auto-placement) |

See [`../README.md`](../README.md) for the full examples matrix.
