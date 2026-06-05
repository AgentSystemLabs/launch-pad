# Rolling releases and health checks

Findings from a review of how rolling deploys work in Launch Pad, with emphasis on
`replicas = 1`, surge behavior, and whether health checks should be required for all web
services.

## Status — implemented (2026-06-04)

The recommendation below shipped, plus two reliability gaps the original review missed:

1. **Health checks are now required for every web service** (`isWeb`), at any replica count
   — not just `replicas > 1`. `packages/shared/src/config.ts` superRefine, with tests in
   `config.test.ts`; `launch-pad init` now emits a default `[service.healthCheck]` for web
   services (`packages/cli/src/commands/init.ts`).
2. **The reason is stronger than "the agent's surge gate":** Caddy's *own* active LB health
   check is also gated on `healthCheck` being present — `caddy.ts` only attaches
   `health_checks.active` when `routes.ts` passes a `healthPath` (`= healthCheck?.path`).
   Without a health check Caddy has **neither active nor passive** checks and round-robins to
   a not-yet-ready upstream immediately. So the doc invariants ("never routes to an unhealthy
   backend", "always ≥1 healthy upstream") only held *when* a health check was configured.
3. **The deploy capacity check now reserves the rollout surge** (it previously reserved
   steady state only, so a tightly-packed node could fail to surge mid-rollout). It adds the
   single largest per-service surge (`min(maxSurge, replicas) × footprint`), maxed per
   resource because a node rolls one service at a time; auto-provision sizing
   (`smallestInstanceTypeFor`) matches. See `packages/shared/src/capacity.ts` (`checkCapacity`),
   `packages/cli/src/commands/deploy.ts` (`demandsOf` / `capacityDemands`), and
   `packages/cli/src/deploy/provision-plan.ts`.

The sections below are the original review that motivated the change; the "Current validation
rule" snippet describes the *pre-change* state.

## How rolling releases work

Rolling updates are **not** a separate orchestrator or release API. They are **agent-driven
reconcile** on each node:

1. `launch-pad deploy` builds an image, pushes an immutable ECR tag, and merges the new
   `image` (and replica counts, etc.) into each target node's `desired.json` in S3.
2. The agent polls `desired.json`, diffs live containers vs desired, and if **any** replica
   runs the old image it plans a single `rollout` action (not per-container replaces).
3. `rolloutService` in `packages/agent/src/reconcile.ts` runs an imperative loop:
   **surge** a new replica → **wait healthy** (if configured) → **add to Caddy** → **remove
   one old from Caddy** → **drain** (`drainTimeout`) → **graceful stop** (`stopGrace`) →
   repeat until all replicas match the desired image.

Invariant (web services with ingress): Caddy should always have at least one healthy
upstream for the domain during rollout, so deploys can be zero-downtime.

### Relevant config (`launch-pad.toml`)

| Field | Role |
| ----- | ---- |
| `replicas` | Container count; Caddy round-robins web replicas |
| `[service.healthCheck]` | Agent polls `http://127.0.0.1:<hostPort><path>` before adding a surged replica to the LB |
| `[service.rollout]` | `maxSurge` (default `1`), `drainTimeout` (default `20s`), `stopGrace` (default `30s`) |

Defaults: `packages/shared/src/health.ts` (`DEFAULT_ROLLOUT`).

Example: `examples/both-node-rolling-replicas/`. Architecture overview:
`docs/overview.md` (section “Health-gated rolling updates”).

### Load balancing modes

- **Co-located (`role = both`, single `node`)**: Caddy on the same machine; `refreshCaddy(excludeIds)` drops draining container IDs from routes.
- **Edge + app**: Each app node rolls its own replicas and publishes an upstream shard to S3; the edge unions shards and programs Caddy over the VPC. Rolling semantics are per app node.

Replica placement across nodes is decided at deploy time (`packages/cli/src/deploy/placement.ts`,
round-robin). Each node's `desired.json` gets its slice of `replicas`; each agent rolls
independently.

### App responsibilities

- Expose the health check path (e.g. `/healthz`) when using health checks.
- Handle **SIGTERM** and drain in-flight work; `stopGrace` maps to `docker stop --time`.

## `replicas = 1` — rolling still runs

**Rolling is not disabled when `replicas = 1`.** Image changes still produce a `rollout`
action in `planReconcile`.

With default `maxSurge = 1`, the node briefly runs **two** containers (old + surged new),
then drains and stops the old one. That is enough headroom for a zero-downtime web deploy
**if** the new replica is gated before traffic and the node has capacity for both instances
during the surge window.

### `replicas = 1` vs `replicas > 1`

| | `replicas = 1` | `replicas > 1` (web) |
| --- | --- | --- |
| Rollout on new image | Yes | Yes |
| `[service.healthCheck]` required by schema | **No** | **Yes** |
| Steady-state redundancy | None; only surge window has two containers | Always another replica in the pool |
| Capacity during deploy | Needs **2×** service CPU/memory briefly | Surge adds on top of existing replicas |

Documentation and examples emphasize `replicas >= 2` for **proven** zero-downtime and
steady-state redundancy, not because `replicas = 1` skips rollout.

## Current validation rule

In `packages/shared/src/config.ts`, health checks are required only when **both** apply:

- the service is a **web** service (`domain` + `port`), and
- `replicas > 1`.

```ts
if (isWeb && s.replicas > 1 && s.healthCheck === undefined) {
  // ... needs [service.healthCheck] for zero-downtime rolling updates
}
```

**Workers** (no `domain`/`port`) may use `replicas > 1` without `healthCheck`; that is
intentional (no Caddy ingress, different rollout path).

## Gap: validation vs runtime behavior

The agent **already** uses health checks for surged replicas whenever `healthCheck` is set
and the service has ingress — including `replicas = 1`:

```ts
if (hc && hostPort !== undefined) {
  if (!(await waitHealthy(hostPort, hc, ceiling))) {
    // abort rollout, tear down new replica
  }
}
```

If `healthCheck` is omitted on a web service with `replicas = 1`, the agent skips
`waitHealthy`, may add the new replica to Caddy immediately, and **zero-downtime is not
guaranteed** even though surge-based rolling still runs.

So the `replicas > 1` rule is a **minimum bar for multi-replica load balancing**, not a
statement that health checks only matter when `replicas > 1`.

## Recommendation: require health checks for all web services

Requiring `[service.healthCheck]` for every web service (`isWeb`), not only when
`replicas > 1`, would:

- Align schema validation with surge-based rolling for `replicas = 1`.
- Make “web ⇒ healthCheck” a single, clear rule.
- Match what `rolloutService` already supports when `healthCheck` is present.

Suggested validation change (conceptually):

```ts
// Before
if (isWeb && s.replicas > 1 && s.healthCheck === undefined) { ... }

// After
if (isWeb && s.healthCheck === undefined) { ... }
```

### Tradeoffs

| Pros | Cons |
|------|------|
| Safer single-replica deploys with default `maxSurge` | Breaking change for existing TOMLs until `healthCheck` is added |
| Simpler mental model | Every web app must expose a probe endpoint |
| No change to worker rules | Slightly more friction for minimal configs |

### Implementation notes (if adopted)

1. Update `packages/shared/src/config.ts` superRefine and `config.test.ts`.
2. Add `[service.healthCheck]` to any web examples that use `replicas = 1` without it.
3. Mention in `docs/overview.md` / `CLAUDE.md` that all web services require health checks.
4. Keep worker validation unchanged (`isWeb` guard stays).

## What rolling is not

- Not cluster-wide atomic: no shared release object; each node reconciles on its own.
- Not the same as steady-state HA: `replicas = 1` relies on surge for overlap, not a second
  always-on replica.
- Workers without ingress still roll images, but without Caddy drain/LB steps (`hasIngress`
  is false).

## Key code references

| Area | Location |
| ---- | -------- |
| Plan rollout on image drift | `packages/agent/src/reconcile.ts` — `planReconcile`, `rolloutService` |
| Health probe / wait | `packages/agent/src/health.ts` |
| Caddy refresh during rollout | `packages/agent/src/index.ts` — `refreshCaddy`, `buildCoLocatedRoutes` |
| Schema + validation | `packages/shared/src/config.ts`, `packages/shared/src/health.ts` |
| Deploy → desired image | `packages/cli/src/commands/deploy.ts` |
| Replica distribution | `packages/cli/src/deploy/placement.ts` |
