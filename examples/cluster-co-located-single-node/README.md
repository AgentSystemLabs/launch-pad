# Example: co-located auto-placement (`topology = "co-located"`)

One both-role node runs the web service's containers **and** the Caddy that serves
its domain — the classic "single box," but chosen by the scheduler instead of pinned
by name. With `schedule = "capacity"` deploy picks the both-role node with room for
**all** replicas (co-located never splits a service across nodes); with the default
`schedule = "even"` it takes the cluster's first both-role node.

```
                              ┌────────────────────────────────┐
 shop.agentsystem.dev ───────▶│  box-a (role: both)             │   cluster: lower
                              │  Caddy :443 → 127.0.0.1:<port>  │
                              │  web ×2 (all replicas here)     │
                              └────────────────────────────────┘
                                       box-b (role: both) — left free
```

## Setup + deploy

```bash
launch-pad cluster create lower --region us-east-1
launch-pad node create box-a --cluster lower --role both
launch-pad node create box-b --cluster lower --role both

launch-pad deploy --cluster lower
```

The placement panel names the chosen node:

```
Placement
  web → box-a×2 (capacity · co-located)
```

Point the domain's A record at **that node's** Elastic IP.

## Notes

- **The cluster default edge is deliberately ignored** — co-located means "no remote
  edge." Setting `edge = "<node-id>"` together with `topology = "co-located"` is a
  config error (use `topology = "split"` if you want a dedicated router).
- **Needs at least one both-role node:** app-role nodes have no Caddy and edge-role
  nodes run no containers, so neither can host a co-located service. Deploy fails
  with a clear error if the cluster has none.
- **DNS follows the placement:** if a later deploy moves the service to another
  both-node (capacity shifted), the old node is cleaned up and the printed placement
  changes — re-point DNS accordingly. Pin with `node = "<id>"` if you never want
  that to happen.
