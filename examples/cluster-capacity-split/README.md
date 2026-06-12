# Example: capacity-aware placement (multi-service bin-packing)

Like `cluster-2-app-nodes-auto-placement`, this config never names a node — but it
adds a second service to show the **capacity scheduler** bin-packing a whole
footprint: each replica lands on the eligible app node with the most free CPU/memory
after existing workloads and rollout-surge headroom. The web service's domain is
fronted by the cluster's dedicated edge node; the worker is packed wherever it fits.

```
                                ┌──────────────────────────────┐
 capacity.agentsystem.dev ─────▶│  edge-lower (role: edge)      │   cluster: lower
                                │  Caddy on :443, auto-HTTPS    │
                                └───────┬───────────────┬──────┘
                                         │ VPC private   │ VPC private
                                ┌────────▼──────┐ ┌──────▼─────────┐
                                │ app-a         │ │ app-b          │
                                │ web ×N        │ │ web ×M         │
                                │ worker ×…     │ │ (N+M = 4, by   │
                                │ (role: app)   │ │  free capacity)│
                                └───────────────┘ └────────────────┘
```

## Setup + deploy

```bash
launchpad cluster create lower --region us-east-1
launchpad node create edge-lower --cluster lower --role edge   # the cluster's one edge
launchpad node create app-a      --cluster lower               # role defaults to "app"
launchpad node create app-b      --cluster lower

launchpad deploy --cluster lower
```

Every deploy prints the resolved placement map:

```
Placement
  web → app-a×2, app-b×2 via edge-lower
  worker → app-b×2
```

With `--json`, the same map is emitted as `placementPlan`:

```json
{ "service": "web", "placements": [{ "nodeId": "app-a", "replicas": 2 }],
  "edge": "edge-lower" }
```

## Notes

- **The scheduler uses deploy's own admission math** (steady demand + the largest
  single rollout surge per node), so a placement it accepts always passes the
  capacity pre-flight. When nothing fits, deploy auto-provisions another app node
  (spend-gated by `--yes` / `--no-create`) or fails with a per-node breakdown
  of free vs needed CPU/memory.
- **Placements can move between deploys** when relative free capacity changes; a
  node the project vacates gets its desired state cleaned up automatically.
  `deploy --restart` never moves replicas — it re-rolls the service exactly where
  it already runs. Volume-bearing services are sticky and never move.
- **Workers have no ingress:** they're packed onto whichever app node has room
  and never touch the edge.
