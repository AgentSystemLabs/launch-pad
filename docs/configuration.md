# Configuration

Each project keeps a **`launch-pad.toml`** in its app root. One file can declare multiple
`[[service]]` blocks (web services and background workers), and multiple projects can share
the same node — deploys merge per-project, never clobbering other projects' services.

The authoritative schema is [`packages/shared/src/config.ts`](../packages/shared/src/config.ts)
(`LaunchPadConfigSchema`), validated with Zod. Parsing uses TOML via `smol-toml`.

## Minimal web service

```toml
project = "my-app"

[[service]]
name = "web"
node = "node-dev-1"
dockerfile = "./Dockerfile"
cpu = 512        # vCPU shares (1024 = 1 vCPU)
memory = 512     # MB
domain = "app.example.com"
port = 3000

  [service.healthCheck]
  path = "/healthz"
```

## Project-level fields

| Field | Description |
| ----- | ----------- |
| `project` | Project name. Namespaces services, images, log groups, and S3 ownership. |
| `domainPattern` | Optional template for `--env` deploys (must contain `{env}`), e.g. `"{env}.example.com"`. |

## `[[service]]` fields

| Field | Description |
| ----- | ----------- |
| `name` | Service name (unique within the project). |
| `node` / `nodes` | Explicit placement: one node id, or a list to spread replicas across. |
| `edge` | For split topology: the edge node that fronts this service's domain. |
| `schedule` | Cluster auto-placement strategy: `"even"` (default, round-robin) or `"capacity"`. |
| `topology` | Auto-placement topology intent: `"auto"` (default), `"split"`, or `"co-located"`. |
| `dockerfile` | Path to the Dockerfile (default `./Dockerfile`). |
| `context` | Docker build context (default `.`). |
| `replicas` | Number of container replicas (default 1). Load-balanced by Caddy. |
| `cpu` | vCPU shares — **1024 = 1 vCPU** (e.g. 512 = half a vCPU). |
| `memory` | Memory limit in **MB**. |
| `env` | Inline environment variables (table of strings). |
| `secrets` | Secret key names resolved from SSM Parameter Store at container start (managed by `launch-pad secret`). |
| `domain` | Public domain (web services only). |
| `domainPattern` | Per-service `{env}` template, overrides the project-level one. |
| `port` | Container port the app listens on (web services only). |
| `[service.healthCheck]` | HTTP health check — **required for every web service**. |
| `[service.rollout]` | Rolling-update tuning (`maxSurge`, `drainTimeout`, `stopGrace`). |

### Web service vs. background worker

- **Web service:** declares **both** `domain` and `port` — gets a Caddy route, automatic
  HTTPS, and load balancing.
- **Worker:** declares **neither** — runs in the background with no public URL and needs no
  health check or DNS.

The schema enforces "both or neither."

### Health checks (required for web services)

Every web service must declare `[service.healthCheck]` at **any** replica count:

```toml
  [service.healthCheck]
  path = "/healthz"        # required
  # port = 3000            # defaults to the service port
  # intervalMs, timeoutMs, healthyThreshold — optional tuning
```

The health check gates a freshly surged replica before it joins the load balancer **and**
feeds Caddy's active health checking — this is what makes rolling updates zero-downtime,
even at `replicas = 1`.

### Rolling updates

```toml
  [service.rollout]
  maxSurge = 1            # extra replicas allowed during a roll
  drainTimeout = "20s"    # wait before stopping an old replica (floored at edge poll cadence)
  stopGrace = "10s"       # SIGTERM → SIGKILL grace
```

Apps should handle `SIGTERM` for graceful drain (see
[`examples/both-node-web-worker`](../examples/both-node-web-worker)).

## Placement

Set **exactly one** of:

1. `node = "node-a"` — pin to one node.
2. `nodes = ["node-a", "node-b"]` — spread replicas across explicit nodes.
3. *Neither* — **cluster auto-placement**: deploy with `--cluster <name>` and the planner
   picks nodes using `schedule` (`even` round-robin or `capacity`-aware bin-packing) and
   `topology` (`split` = app nodes behind a dedicated edge, `co-located` = one both-role
   node, `auto` = inferred). Capacity placement uses the same admission math as the deploy
   pre-flight, so a planned placement can never fail admission.

**Empty-cluster bootstrap:** the first deploy of auto-placed services to a cluster that has
**no nodes yet** doesn't error — `deploy` auto-provisions a single co-located node (`app-1`)
and places onto it (parity with the default cluster's single-node auto-provision), then
auto-sizes the instance to fit. This is spend-gated like any provision (confirm prompt,
`--yes` in CI, `--no-create` to opt out). A service that declares `topology = "split"` still
needs a dedicated edge — set one with `cluster set-edge` (or `edge = …` on the service)
before the first deploy, or the bootstrap routes through it / provisions it as needed.

Only cluster-auto-placed (option 3) services can be **moved after deployment** without a
re-deploy: [`launch-pad rebalance`](cli.md#rebalance) replans them across the current pool
(after adding/removing app nodes), and [`node evacuate`](cli.md#node-evacuate-name) moves them
off a node before pause/destroy. Pinned services (options 1–2) are frozen by the config lock.

Deploy runs a **capacity admission check** before publishing: steady-state demand plus the
largest single rollout surge must fit each node (with reserved host headroom). Auto-provision
sizes new instances for that same peak.

**Auto-add on capacity pressure:** when cluster-auto-placed services don't fit the current
pool (e.g. you scaled replicas up), deploy **adds app node(s)** — named `app-<n>`, sized like
the cluster's existing nodes — and re-plans onto the larger pool, rather than erroring "reduce
cpu/memory/replicas". This is spend-gated by the same confirmation as any provision (`--yes`
in CI), bounded by the replica count, and disabled by `--no-create` (which restores the
hard-error behavior). It applies to both `even` and `capacity` scheduling.

## Environments (`--env`)

`deploy --env staging` deploys the same config as a separate **footprint**
(`<project>-<env>`): domains are projected through `domainPattern` (the `{env}` token is
required so environments can't collide), and services/images/logs/secrets are all
namespaced. `status --env`, `logs --env`, and `secret --env` scope to the same footprint.

## Secrets

Secret **values** live in SSM Parameter Store (SecureString) — never in git, the TOML, or
S3 `desired.json`. The TOML only registers key **names** under `secrets = [...]`:

```bash
launch-pad secret set DATABASE_URL --service api   # prompts for value, registers key
launch-pad deploy --restart --service api          # roll containers to pick it up
```

SSM path layout: `/launch-pad/<cluster>/<ownerProject>/<service>/<KEY>`. The agent resolves
secrets at container start and merges them with `env` (plain `env` wins on collision). IAM
details are in [cli.md](cli.md#secret).

## Config lock

After the first successful deploy, the CLI freezes a baseline snapshot
(`config-baseline.json` in S3). From then on only the **operational** fields may change:

| Mutable post-deploy | How to change it |
| ------------------- | ---------------- |
| `cpu`, `memory` (vertical scale) | `launch-pad scale cpu\|memory <service> <value>` |
| `replicas` (horizontal scale) | `launch-pad scale replicas <service> <count>` |
| `env` (non-secret config) | `launch-pad config set\|unset <service> KEY[=VALUE]` |
| `secrets` (key names) | `launch-pad secret set\|rm <KEY>` |

Everything else is the project's **identity / shape** and stays locked: placement
(`node`/`nodes`/`edge`/`schedule`/`topology`), build inputs (`dockerfile`/`context`),
domains, ports, health checks, and rollout settings. Changing a locked field — or adding or
renaming a service — aborts the deploy *before* any build or push. There is no bypass flag;
to change a locked field you re-create the footprint.

**Removing a service** is the one locked change with a sanctioned path: rather than delete a
`[[service]]` block and have the next deploy abort with "service removed", run
[`launch-pad undeploy --service <name>`](cli.md#undeploy). It drops the service from the
nodes *and* trims the frozen baseline, so a follow-up `deploy` of the edited TOML (block
removed) passes the lock. `launch-pad undeploy` with no `--service` removes the whole
footprint and clears the baseline entirely, so the next deploy is a fresh first deploy with
identity unlocked again.

You can still hand-edit a mutable field in `launch-pad.toml` and run `launch-pad deploy` — the
`scale` and `config` commands are just ergonomic wrappers that edit the file and deploy the one
service for you (health-gated, zero-downtime). (Schema:
[`packages/shared/src/config-lock.ts`](../packages/shared/src/config-lock.ts).)

## Local CLI preferences

`~/.launch-pad/config.toml` stores **local-only** cluster → AWS target mappings (region,
profile) and your default cluster (`cluster use <name>`). S3 remains the authoritative
registry of nodes and deploy state — local config is never the source of truth for what
exists.
