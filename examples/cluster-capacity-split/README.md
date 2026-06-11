# Example: capacity-aware placement (`schedule = "capacity"`, `topology = "split"`)

Like `cluster-2-app-nodes-auto-placement`, this config never names a node — but instead
of round-robin it asks the **capacity scheduler** to bin-pack: each replica lands on the
eligible node with the most free CPU/memory after existing workloads and rollout-surge
headroom. `topology = "split"` keeps the web service's containers on the cluster's
app/both nodes and fronts the domain with the cluster's default edge.

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
launch-pad cluster create lower --region us-east-1
launch-pad node create edge-lower --cluster lower --role edge   # becomes the default edge
launch-pad node create app-a      --cluster lower --role app
launch-pad node create app-b      --cluster lower --role app

launch-pad deploy --cluster lower
```

Every deploy prints the resolved placement map:

```
Placement
  web → app-a×2, app-b×2 via edge-lower (capacity · split)
  worker → app-b×2 (capacity · auto)
```

With `--json`, the same map is emitted as `placementPlan`:

```json
{ "service": "web", "placements": [{ "nodeId": "app-a", "replicas": 2 }],
  "edge": "edge-lower", "topology": "split", "schedule": "capacity", "pinned": false }
```

## Notes

- **The scheduler uses deploy's own admission math** (steady demand + the largest
  single rollout surge per node), so a placement it accepts always passes the
  capacity pre-flight. When nothing fits, deploy fails with a per-node breakdown
  of free vs needed CPU/memory.
- **Placements can move between deploys** when relative free capacity changes; a
  node the project vacates gets its desired state cleaned up automatically.
  `deploy --restart` never moves replicas — it re-rolls the service exactly where
  it already runs.
- **Workers ignore topology** (they have no ingress): `schedule = "capacity"` alone
  packs them onto whichever app/both node has room.
- **Locked after first deploy:** `schedule`/`topology` join `node`/`nodes`/`edge`
  in the config lock — only `cpu`/`memory` may change later.
