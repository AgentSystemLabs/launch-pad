# Launch Pad examples

Runnable `launch-pad.toml` configs and the shared Express fixture in
[`web-worker`](web-worker). Each directory is self-contained except paths
into `web-worker` for `Dockerfile` / `context`.

Placement is fully automatic in every example: the TOML never names a node.
The scheduler bin-packs services across the cluster's **app** nodes, and every
web service routes through the cluster's single dedicated **edge** node (Caddy,
public 80/443). A first deploy on an empty cluster auto-provisions `edge-1` +
`app-1`; you can also pre-create nodes with `launchpad node create`.

## Quick pick

| You want to try… | Directory |
| ---------------- | --------- |
| First deploy, web + background worker (the canonical fixture) | [`web-worker`](web-worker) |
| Rolling replicas spread across **two** app nodes | [`edge-2-app-nodes-rolling-replicas`](edge-2-app-nodes-rolling-replicas) |
| Multiple envs behind one edge (`--env`, flat domains) | [`edge-1-app-deploy-env-flat-domains`](edge-1-app-deploy-env-flat-domains) |
| Same, with `domainPattern` + `shop.example.com` DNS | [`edge-1-app-deploy-env-shop-domains`](edge-1-app-deploy-env-shop-domains) |
| Same, with nested env hosts (`ui-<name>.multi…`, `*.multi` DNS) | [`edge-1-app-deploy-env-nested-multi-dns`](edge-1-app-deploy-env-nested-multi-dns) |
| Named cluster + auto-placement (`deploy --cluster`) | [`cluster-2-app-nodes-auto-placement`](cluster-2-app-nodes-auto-placement) |
| Multi-service capacity bin-packing (web + worker) | [`cluster-capacity-split`](cluster-capacity-split) |
| Scheduled job (cron worker, one container per fire) | [`cron-task`](cron-task) |
| Persistent named volume (sticky placement) | [`worker-with-volume`](worker-with-volume) |
| Headless cursor-agent swarm (WAL locks + GitHub issues) | [`swarm`](swarm) |

## Coverage matrix

| Example | Nodes | `--env` | `replicas` > 1 | `rollout` | Worker (no domain) | Multi-service |
| ------- | ----- | ------- | -------------- | --------- | ------------------ | ------------- |
| `web-worker` | edge + 1 app (auto) | — | yes (web) | yes | yes | yes |
| `edge-2-app-nodes-rolling-replicas` | edge + 2 app | — | yes (4) | yes | — | — |
| `edge-1-app-deploy-env-flat-domains` | edge + 1 app | yes | — | — | — | api + web |
| `edge-1-app-deploy-env-shop-domains` | edge + 1 app | yes | — | — | — | api + ui |
| `edge-1-app-deploy-env-nested-multi-dns` | edge + 1 app | yes | — | — | — | api + ui |
| `cluster-2-app-nodes-auto-placement` | edge + 2 app (named cluster) | — | yes (4) | yes | — | — |
| `cluster-capacity-split` | edge + 2 app (named cluster) | — | yes (4) | yes | yes | yes |
| `cron-task` | edge + 1 app (auto) | — | — | — | yes (cron) | — |
| `worker-with-volume` | edge + 1 app (auto) | — | — | — | yes | — |
| `swarm` | edge + N app (scale out) | — | yes (workers) | — | yes | wal + engineer |

## Edge cases exercised

- **Split topology everywhere:** the edge node runs Caddy only; app nodes are
  VPC-private (no public 80/443) and reachable only by the edge's security group.
  `web-worker` is the smallest end-to-end run (edge + one app node).
- **One app pool, many env footprints:** `edge-1-app-deploy-env-*` — `deploy --env`
  namespaces owner + domains; containers from different envs share the app pool.
- **Multi-node replica spread:** `edge-2-app-nodes-rolling-replicas` — the scheduler
  spreads 4 replicas across two app nodes; the same edge fronts them all.
- **Cluster abstraction:** `cluster-2-app-nodes-auto-placement` — deploy into a named
  cluster with `--cluster`; no infrastructure names anywhere in the TOML.
- **Capacity bin-packing:** `cluster-capacity-split` — multi-service footprint; the
  scheduler packs the worker by free CPU/memory while the web service rides the edge.
- **Domain projection:** `domainPattern` at project and service level (`edge-1-app-deploy-env-*`);
  default `-<env>` after first label when pattern omitted.
- **Nested env under a zone:** `edge-1-app-deploy-env-nested-multi-dns` — `ui-{env}.multi.agentsystem.dev`
  needs `*.multi.agentsystem.dev`, not just `*.agentsystem.dev`.
- **Health + rolling deploy:** `web-worker`, `edge-2-app-nodes-rolling-replicas`,
  `cluster-2-app-nodes-auto-placement` — `/healthz`, `maxSurge`, drain/stop grace.
- **Web vs worker:** `web-worker` — `domain`+`port` vs worker with neither.
- **Sticky volumes:** `worker-with-volume` — the scheduler places a volume-bearing
  service once and keeps it there; rebalance/evacuate refuse to move it.
- **DNS patterns:** wildcard at the edge (`edge-1-app-deploy-env-flat-domains`,
  `edge-1-app-deploy-env-shop-domains`); nested zone wildcard
  (`edge-1-app-deploy-env-nested-multi-dns`: `multi` + `*.multi`); single A record
  at the edge EIP (`edge-2-app-nodes-rolling-replicas`, `cluster-2-app-nodes-auto-placement`).

## Gaps (intentionally not a separate example yet)

- Cross-account clusters (`docs/overview.md` clusters section).
- Reactive autoscaling (`launchpad autoscale`) — exercised by the e2e harness,
  not a runnable example dir.

When adding a new example, extend this matrix and the quick-pick table so the set stays
discoverable.
