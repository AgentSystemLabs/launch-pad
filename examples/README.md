# Launch Pad examples

Runnable `launch-pad.toml` configs and the shared Express fixture in
[`both-node-web-worker`](both-node-web-worker). Each directory is self-contained except paths
into `both-node-web-worker` for `Dockerfile` / `context`.

## Quick pick

| You want to try… | Directory |
| ---------------- | --------- |
| First deploy, web + background worker, co-located Caddy | [`both-node-web-worker`](both-node-web-worker) |
| Dedicated edge router + one Express web app (minimal split) | [`edge-and-app-on-one-node`](edge-and-app-on-one-node) |
| Zero-downtime rolling updates (`replicas`, `rollout`) | [`both-node-rolling-replicas`](both-node-rolling-replicas) |
| Dedicated edge, rolling replicas across **two** app nodes | [`edge-2-app-nodes-rolling-replicas`](edge-2-app-nodes-rolling-replicas) |
| Dedicated edge, multiple envs on **one** app node (`--env`, flat domains) | [`edge-1-app-deploy-env-flat-domains`](edge-1-app-deploy-env-flat-domains) |
| Same, with `domainPattern` + `shop.example.com` DNS | [`edge-1-app-deploy-env-shop-domains`](edge-1-app-deploy-env-shop-domains) |
| Same, with nested env hosts (`ui-<name>.multi…`, `*.multi` DNS) | [`edge-1-app-deploy-env-nested-multi-dns`](edge-1-app-deploy-env-nested-multi-dns) |
| Cluster auto-placement (no explicit node names in TOML) | [`cluster-2-app-nodes-auto-placement`](cluster-2-app-nodes-auto-placement) |
| Capacity-aware placement + split topology (`schedule`/`topology`) | [`cluster-capacity-split`](cluster-capacity-split) |
| Single-box auto-placement, no remote edge (`topology = "co-located"`) | [`cluster-co-located-single-node`](cluster-co-located-single-node) |

## Coverage matrix

| Example | Node role | Edge | Placement (`schedule` · `topology`) | `--env` | `replicas` > 1 | `rollout` | Worker (no domain) | Multi-service |
| ------- | --------- | ---- | ----------------------------------- | ------- | -------------- | --------- | ------------------ | ------------- |
| `both-node-web-worker` | `both` (default) | co-located | explicit `node` | — | yes (web) | yes | yes | yes |
| `edge-and-app-on-one-node` | `edge` + `app` | dedicated | one app node | — | — | — | — | — |
| `both-node-rolling-replicas` | `both` | co-located | explicit `node` | — | yes | yes | — | — |
| `edge-2-app-nodes-rolling-replicas` | `edge` + `app` | dedicated | `nodes` (2 app) | — | yes | yes | — | — |
| `edge-1-app-deploy-env-flat-domains` | `edge` + `app` | dedicated | one app node | yes | — | — | — | api + web |
| `edge-1-app-deploy-env-shop-domains` | `edge` + `app` | dedicated | one app node | yes | — | — | — | api + ui |
| `edge-1-app-deploy-env-nested-multi-dns` | `edge` + `app` | dedicated | one app node | yes | — | — | — | api + ui |
| `cluster-2-app-nodes-auto-placement` | `edge` + `app` | cluster default | `deploy --cluster lower` (even · auto) | — | yes (4) | yes | — | — |
| `cluster-capacity-split` | `edge` + `app` | cluster default | auto (capacity · split) | — | yes (4) | yes | yes | yes |
| `cluster-co-located-single-node` | `both` ×2 | co-located (no remote edge) | auto (capacity · co-located) | — | yes (2) | yes | — | — |

## Edge cases exercised

- **Co-located vs split edge:** `both-node-*` use role `both`; `edge-*` and `cluster-*` use a
  public edge plus private app nodes. Start with `edge-and-app-on-one-node` for the smallest split
  (one router, one web service).
- **One app node, many env footprints:** `edge-1-app-deploy-env-*` — `deploy --env`
  namespaces owner + domains; containers from different envs share `node-app`.
- **Explicit multi-node placement:** `edge-2-app-nodes-rolling-replicas` — `nodes = ["app-a", "app-b"]`
  spreads replicas; same edge router.
- **Cluster abstraction:** `cluster-2-app-nodes-auto-placement` — no `node`/`edge` in TOML; CLI
  places replicas and picks the cluster edge.
- **Capacity scheduling + topology intent:** `cluster-capacity-split` — `schedule = "capacity"`
  bin-packs by free CPU/memory; `topology = "split"` fronts the domain with the cluster edge.
  `cluster-co-located-single-node` — `topology = "co-located"` keeps all replicas + Caddy on one
  both-role node and deliberately ignores the cluster default edge.
- **Domain projection:** `domainPattern` at project and service level (`edge-1-app-deploy-env-*`);
  default `-<env>` after first label when pattern omitted.
- **Nested env under a zone:** `edge-1-app-deploy-env-nested-multi-dns` — `ui-{env}.multi.agentsystem.dev`
  needs `*.multi.agentsystem.dev`, not just `*.agentsystem.dev`.
- **Health + rolling deploy:** `both-node-*`, `edge-2-app-nodes-rolling-replicas`,
  `cluster-2-app-nodes-auto-placement` — `/healthz`, `maxSurge`, drain/stop grace.
- **Web vs worker:** `both-node-web-worker` — `domain`+`port` vs worker with neither.
- **DNS patterns:** wildcard at edge (`edge-1-app-deploy-env-flat-domains`,
  `edge-1-app-deploy-env-shop-domains`); nested zone wildcard
  (`edge-1-app-deploy-env-nested-multi-dns`: `multi` + `*.multi`); per-host A records
  (`edge-2-app-nodes-rolling-replicas`, `cluster-2-app-nodes-auto-placement`).

## Gaps (intentionally not a separate example yet)

- Multi-node replica spread via explicit `nodes = ["app-1", "app-2"]` combined with `--env`
  (described in `docs/overview.md`, not a runnable dir).
- Cross-account clusters (`docs/overview.md` clusters section).
- `--env` with `--node` override to isolate one environment on a different app node
  (documented in `edge-1-app-deploy-env-shop-domains` README only).

When adding a new example, extend this matrix and the quick-pick table so the set stays
discoverable.
