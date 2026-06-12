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
| `component` | Optional. This repo's deployable slice of the project (federated multi-repo deploys — see below). |
| `domainPattern` | Optional template for `--env` deploys (must contain `{env}`), e.g. `"{env}.example.com"`. |

### Components (federated multi-repo deploys)

One logical product can be split across several repos that each own a slice of it —
e.g. `auth`, `portal`, and `notes` repos all declaring `project = "shop"` with their own
`component`:

```toml
project = "shop"        # the logical product — shared across repos
component = "auth"      # this repo's slice (unique within the project)

[[service]]
name = "auth"
# ...
```

Each component deploys **independently and safely**: its footprint owner is the derived
`<project>--<component>` (e.g. `shop--auth`), so its config lock, baseline, secrets tree,
deploy history, and env footprints are component-scoped, and a full `launchpad deploy`
from one component repo never touches a sibling component's services — even when they
share nodes. `launchpad project show shop` still aggregates the whole product across
components (deploys register each component in a per-project index in S3).

Rules and caveats:

- **`component` is optional.** A TOML without it owns the whole project footprint —
  existing single-TOML projects (monorepo or not) work unchanged.
- **Service names must be unique across the project's components** — they share one ECR
  repo namespace (`<project>/<service>`). Deploy refuses a duplicate before building.
- **`--` is reserved** as the project/component separator and rejected inside either label.
- **Adding `component` to an already-deployed project forks the footprint**: the new
  owner has no baseline, while the old `<project>` footprint keeps running. Destroy the
  old footprint first (`launchpad destroy` from the old TOML), then deploy the split
  components — the duplicate-service check guides this migration.
- Env markers written by component deploys are not readable by **older CLI versions**
  (they skip them with a warning) — upgrade CI runners that run `destroy --prune-expired`.

## `[[service]]` fields

| Field | Description |
| ----- | ----------- |
| `name` | Service name (unique within the project). |
| `dockerfile` | Path to the Dockerfile (default `./Dockerfile`). |
| `context` | Docker build context (default `.`). |
| `replicas` | Number of container replicas (default 1). Load-balanced by Caddy. |
| `cpu` | vCPU shares — **1024 = 1 vCPU** (e.g. 512 = half a vCPU). |
| `memory` | Memory limit in **MB**. |
| `env` | Inline environment variables (table of strings). |
| `secrets` | Secret key names resolved from SSM Parameter Store at container start (managed by `launchpad secret`). |
| `domain` | Public domain (web services only). |
| `domainPattern` | Per-service `{env}` template, overrides the project-level one. |
| `port` | Container port the app listens on (web services only). |
| `[service.healthCheck]` | HTTP health check — **required for every web service**. |
| `[service.rollout]` | Rolling-update tuning (`maxSurge`, `drainTimeout`, `stopGrace`). |
| `[[service.volumes]]` | Persistent named volumes (`name` + container `path`) — data survives a container replace. Makes the service's placement **sticky** (all replicas on one node; never moved). |
| `cron` | 5-field cron expression (UTC) turning a worker into a **scheduled job** — one container per fire, judged by exit code. Workers only. |

### Web service vs. background worker

- **Web service:** declares **both** `domain` and `port` — gets a Caddy route, automatic
  HTTPS, and load balancing.
- **Worker:** declares **neither** — runs in the background with no public URL and needs no
  health check or DNS.
- **Scheduled job:** a worker with a `cron` expression — the agent runs one container per
  fire and lets it exit, instead of keeping it alive. See [Scheduled jobs](#scheduled-jobs-cron).

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
[`examples/web-worker`](../examples/web-worker)).

### Scheduled jobs (cron)

A worker with a `cron` field becomes a scheduled job: the agent starts **one container per
fire**, lets it run to completion, and records the exit code — there is no long-running
process and no restart-on-exit.

```toml
[[service]]
name = "nightly-report"
cron = "0 3 * * *"       # 03:00 UTC daily
cpu = 256
memory = 256
```

Expression semantics (standard 5-field vixie cron, **evaluated in UTC**): minute, hour,
day-of-month, month, day-of-week (`0`–`7`, both `0` and `7` are Sunday); `*`, lists (`1,15`),
ranges (`1-5`), and steps (`*/5`, `1-30/10`) are supported; month/day **names are not**
(numeric only). When both day-of-month and day-of-week are restricted, a fire matches on
**either** (the vixie rule).

Behavior and rules:

- **Workers only** — `cron` can't be combined with `domain`/`port` or a `healthCheck` (a run
  is judged by its **exit code**, not a probe), and `replicas` must stay 1 (one run per fire).
- **No overlap, no catch-up:** a run still in progress suppresses the next fire, and missed
  fires (agent down, long previous run) collapse to a **single** run — never a backlog storm.
  A freshly deployed schedule is anchored at first sight: it waits for the *next* fire rather
  than replaying past ones.
- **Observability:** `status.json` (and `launchpad status` / `node show`) carry a `cron`
  rollup — `lastRunAt`, `lastExitCode`, `nextRunAt`. A failed run surfaces there and in the
  service message; it does **not** flip the service to `error` (so a later deploy's
  convergence watch can't be wedged by one bad run). The run's stdout/stderr ship to
  CloudWatch like any worker (`launchpad logs`).
- **New image / env / secrets apply at the next fire** — each run starts fresh from current
  desired state, so there is no rolling update (and `deploy --restart` is effectively a no-op
  for a cron service).
- **The cron expression is config-locked identity** — like volumes, it can't
  change after the first deploy (`destroy --service` it to change its cadence). `scale
  replicas` refuses cron services; `scale cpu/memory` works.
- Capacity admission counts a cron service like a 1-replica worker (its cpu/memory are
  reserved full-time — conservative, so a fire can never be starved).
- Like volumes, `cron` is a new `desired.json` field a **pre-cron agent won't parse** — run
  `launchpad node upgrade-agent` on existing nodes before the first cron deploy (nodes
  created by a cron-aware CLI are fine).
  See [`examples/cron-task`](../examples/cron-task).

### Persistent volumes

A service can declare persistent named volumes. The data lives on the node's disk (a docker
named volume on the root EBS volume) and **survives a container replacement** — a rolling
deploy, a `deploy --restart`, or a node reboot — instead of resetting on every deploy. This is
what SQLite databases, user uploads, and local caches need.

```toml
[[service]]
name = "ledger"
cpu = 256
memory = 256

  [[service.volumes]]
  name = "data"          # unique within the service
  path = "/data"         # absolute container mount path

  [[service.volumes]]
  name = "uploads"
  path = "/var/uploads"
```

Rules:

- **A volume-bearing service's placement is sticky.** A volume's data has a home on exactly
  one node's disk, so the scheduler places **all** its replicas on one node and later
  deploys/rebalances keep it there. If that node lacks capacity for a resize, it's a hard
  error (the data can't move), and draining/evacuating its node is refused. For an
  exclusive-writer store like SQLite, also keep `replicas = 1` — replicas on the same node
  share the volume.
- **Volumes are config-locked identity** — like `port`, you can't add,
  remove, or re-path a volume after the first deploy (re-create the footprint to change them).
- The data is **kept** on `destroy` / `node destroy` of the data (the volume isn't deleted), so
  a redeploy reattaches it. It is **not** replicated and does **not** survive terminating the
  instance — it's node-local durability, not a managed database.
- See [`examples/worker-with-volume`](../examples/worker-with-volume).
- Upgrade a node's agent (`launchpad node upgrade-agent`) to a volumes-aware build **before** the
  first deploy from a volumes-aware CLI — that deploy adds the `volumes` field to every service in
  the node's `desired.json`, which a pre-volumes agent won't parse.

## Placement

Placement is **fully automatic** — `launch-pad.toml` carries no node names. The scheduler
bin-packs services across the cluster's **app nodes** by free CPU/memory (spreads across
empty nodes when possible; stacks when necessary), using the same admission math as the
deploy pre-flight, so a planned placement can never fail admission. The resolved placement
map prints on every deploy. (The legacy `node`/`nodes`/`edge`/`schedule`/`topology` service
fields were removed — parsing rejects them with a migration hint; just delete them from the
TOML.)

Web traffic always routes through the cluster's **dedicated edge node** (Caddy + automatic
HTTPS, public 80/443, Elastic IP), so every cluster runs at least **2 nodes**: the edge +
≥1 app node. App nodes are VPC-private — no public ingress; reachable only by the edge's
security group on the host-port range.

**Empty-cluster bootstrap:** the first deploy to a cluster with **no nodes yet** doesn't
error — `deploy` auto-provisions the dedicated edge (`edge-1`, default `t3.micro`) and a
first app node (a generated `<noun>-<verb>-<adverb>` name, auto-sized to fit the footprint).
This is spend-gated like any
provision (confirm prompt, `--yes` in CI, `--no-create` to opt out). To use an existing
edge instead, set it with `cluster set-edge` before the first deploy.

Services can be **moved after deployment** without a re-deploy:
[`launchpad rebalance`](cli.md#rebalance) replans the footprint across the current app pool
(after adding/removing app nodes), and [`node evacuate`](cli.md#node-evacuate-name) moves
services off a node before pause/destroy. The exception is a volume-bearing service — its
placement is **sticky** (the data lives on one node's disk), it never moves, and draining
its node is refused.

Deploy runs a **capacity admission check** before publishing: steady-state demand plus the
largest single rollout surge must fit each node (with reserved host headroom). Auto-provision
sizes new instances for that same peak.

**Auto-add on capacity pressure:** when the footprint doesn't fit the current pool (e.g. you
scaled replicas up), deploy **adds app node(s)** — with generated names, sized like the cluster's
existing nodes — and re-plans onto the larger pool, rather than erroring "reduce
cpu/memory/replicas". This is spend-gated by the same confirmation as any provision (`--yes`
in CI), bounded by the replica count, and disabled by `--no-create` (which restores the
hard-error behavior).

## Environments (`--env`)

`deploy --env staging` deploys the same config as a separate **footprint**
(`<project>-<env>`): domains are projected through `domainPattern` (the `{env}` token is
required so environments can't collide; without a pattern the domain's first label is
suffixed — `app.example.com` → `app-staging.example.com`), and services/images/logs/secrets
are all namespaced. `status --env`, `logs --env`, and `secret --env` scope to the same
footprint.

DNS for environments is **yours to configure, once**: a single wildcard DNS-only A record at
the edge's Elastic IP (e.g. `*.example.com → <edge EIP>`) covers every projected env
subdomain — no per-env DNS work. The deploy's DNS panel prints the exact targets and
`launchpad dns verify <domain>` checks them. Each `--env` deploy records the env in an env
marker. Add `--ttl 72h` for a PR env that `launchpad destroy --prune-expired` tears down
after the deadline — see [cli.md](cli.md#destroy) for the full env lifecycle
(`destroy --list-envs` / `--env` / `--prune-expired`).

## Secrets

Secret **values** live in SSM Parameter Store (SecureString) — never in git, the TOML, or
S3 `desired.json`. The TOML only registers key **names** under `secrets = [...]`:

```bash
launchpad secret set DATABASE_URL --service api   # prompts for value, registers key
launchpad deploy --restart --service api          # roll containers to pick it up
```

SSM path layout: `/launch-pad/<cluster>/<ownerProject>/<service>/<KEY>`. The agent resolves
secrets at container start and merges them with `env` (plain `env` wins on collision). IAM
details are in [cli.md](cli.md#secret).

## Config lock

After the first successful deploy, the CLI freezes a baseline snapshot
(`config-baseline.json` in S3). From then on only the **operational** fields may change:

| Mutable post-deploy | How to change it |
| ------------------- | ---------------- |
| `cpu`, `memory` (vertical scale) | `launchpad scale cpu\|memory <service> <value>` |
| `replicas` (horizontal scale) | `launchpad scale replicas <service> <count>` |
| `env` (non-secret config) | `launchpad config set\|unset <service> KEY[=VALUE]` |
| `secrets` (key names) | `launchpad secret set\|rm <KEY>` |
| `domainPattern` (env hostname projection) | edit `launch-pad.toml` and redeploy |

Everything else is the project's **identity / shape** and stays locked: build inputs
(`dockerfile`/`context`), production `domain`, ports, health checks, rollout settings,
`cron`, and persistent `volumes`. Changing a locked field —
or adding or renaming a service — aborts the deploy *before* any build or push. There is no
bypass flag; to change a locked field you re-create the footprint.

(Placement isn't in the TOML at all, so it is never config-locked — services move via
[`rebalance`](cli.md#rebalance) / `node evacuate`, except volume-bearing services, which
are sticky.)

**Removing a service** is the one locked change with a sanctioned path: rather than delete a
`[[service]]` block and have the next deploy abort with "service removed", run
[`launchpad destroy --service <name>`](cli.md#destroy). It drops the service from the
nodes *and* trims the frozen baseline, so a follow-up `deploy` of the edited TOML (block
removed) passes the lock. `launchpad destroy` with no `--service` removes the whole
footprint and clears the baseline entirely, so the next deploy is a fresh first deploy with
identity unlocked again.

You can still hand-edit a mutable field in `launch-pad.toml` and run `launchpad deploy` — the
`scale` and `config` commands are just ergonomic wrappers that edit the file and deploy the one
service for you (health-gated, zero-downtime). (Schema:
[`packages/shared/src/config-lock.ts`](../packages/shared/src/config-lock.ts).)

## Local CLI preferences

`~/.launch-pad/config.toml` stores **local-only** cluster → AWS target mappings (region,
profile) and your default cluster (`cluster use <name>`). S3 remains the authoritative
registry of nodes and deploy state — local config is never the source of truth for what
exists.
