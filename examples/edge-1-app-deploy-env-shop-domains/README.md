# Example: one config, many environments (`--env`)

Ship production **and** any number of named environments (previews, QA, load tests)
from a single `launch-pad.toml` — without editing it. Every environment runs an
isolated footprint behind the **same cluster edge router**.

For the same setup (shared edge, multiple envs on the cluster's app pool) with
`agentsystem.dev` hosts, see [`../edge-1-app-deploy-env-flat-domains`](../edge-1-app-deploy-env-flat-domains).

For **nested** env hostnames (`ui-<name>.multi.agentsystem.dev`, `*.multi` DNS), see
[`../edge-1-app-deploy-env-nested-multi-dns`](../edge-1-app-deploy-env-nested-multi-dns).

```
                          ┌──────────────────────────────┐
  shop.example.com ──────▶│  node-edge (role: edge)       │
  api.shop.example.com ──▶│  Caddy :443, auto-HTTPS        │
  <name>.shop.example.com │  one router, every env's host  │
  api-<name>.shop…  ─────└───────────────┬───────────────┘
                                           │ VPC private
                                  ┌────────▼──────────┐
                                  │ node-app (app)    │
                                  │  shop/* (default) │
                                  │  shop-<name>/*    │
                                  └───────────────────┘
```

## Deploy production

```bash
npx @agentsystemlabs/launch-pad deploy
```

Serves `api.shop.example.com` and `shop.example.com`. Footprint owner: `shop`.
(A first deploy on an empty cluster auto-provisions the edge + app node pair.)

## Deploy a named environment — same file, one flag

```bash
npx @agentsystemlabs/launch-pad deploy --env preview
```

- **Domains are projected:** `api` → `api-preview.shop.example.com` (project
  default pattern), `ui` → `preview.shop.example.com` (its per-service override).
- **Footprint is namespaced:** owner becomes `shop-preview`, so the preview
  containers (`launchpad_shop-preview_api_*`) run alongside production on the
  cluster's app node(s) with no collision. Each container also gets
  `LAUNCH_PAD_ENVIRONMENT=preview`.
- **Same image:** identical code → identical content tag → preview reuses the
  already-pushed production image (no rebuild).
- **Same edge:** the projected domains just appear as new routes on the edge node.

`launchpad status --env preview` shows only that footprint.

CI just runs `deploy --env "$ENV"` — nothing in this repo changes per environment.

## DNS — two static records, no Route53

Point them at the **edge's** Elastic IP (shown by `node create node-edge` or the
first deploy's provisioning panel), once, at any DNS provider:

```
shop.example.com     A   <edge elastic ip>     # apex (production ui)
*.shop.example.com   A   <edge elastic ip>     # api, <name>.*, api-<name>.*, …
```

A wildcard is single-label, so `*.shop.example.com` covers every one-label host
under `shop.example.com` (production + every `--env`). If you ever nest deeper
(`ui-<name>.testing.shop.example.com`), add a `*.testing.shop.example.com` record at
that depth. Caddy issues each host's cert automatically via HTTP-01 — no wildcard
cert, no DNS API.
