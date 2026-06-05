# Example: replicas + zero-downtime rolling updates (single node)

One node, co-located Caddy, **two replicas** of a web service. Caddy round-robin
load-balances the replicas, and a re-deploy performs a **health-gated rolling
update** with no dropped requests.

It reuses the Express app in [`../both-node-web-worker`](../both-node-web-worker) (which has
a `/healthz` endpoint and a SIGTERM graceful-shutdown handler).

## Provision + deploy

```bash
# a single "both" node (runs containers AND Caddy)
npx @agentsystemlabs/launch-pad node create solo-1

# point demo.example.com's A record at solo-1's Elastic IP, then:
npx @agentsystemlabs/launch-pad deploy
```

You'll see two containers `launchpad_replicas-demo_web_0` and `…_web_1`, and Caddy
load-balancing across them (each request may hit a different replica — the response
includes the replica hostname).

## Watch a rolling update

In one terminal, hammer the endpoint:

```bash
while true; do curl -s https://demo.example.com/; sleep 0.2; done
```

In another, bump `RELEASE` in `../both-node-web-worker/server.js` (e.g. `v1` → `v2`) and
re-deploy:

```bash
npx @agentsystemlabs/launch-pad deploy
```

The agent surges a new replica, waits for it to pass `/healthz`, adds it to the load
balancer, drains an old one for `drainTimeout`, then gracefully stops it — repeating
until both replicas run the new image. The curl loop **never errors**, and the
response flips from `v1` to `v2` mid-stream.

## How it maps to the config

| Field | Effect |
| ----- | ------ |
| `replicas = 2` | two containers, Caddy load-balances them |
| `healthCheck.path` | a surged replica must return 2xx here before the old one drains |
| `rollout.maxSurge` | how many new replicas to add before removing an old one |
| `rollout.drainTimeout` | how long to keep a de-routed replica before stopping it |
| `rollout.stopGrace` | `docker stop --time` grace (SIGTERM → grace → SIGKILL) |
