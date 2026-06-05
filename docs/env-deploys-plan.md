# Feature Plan — Environment deploys (`--env`)

> Status: **in progress** (Phase 1 landing). Companion to `docs/overview.md` and
> `docs/clusters-plan.md`. Adds a deploy-time **environment** flag that projects a
> service's domain and namespaces its footprint, so the same `launch-pad.toml`
> ships to prod, staging, dev, or a per-PR preview **without editing the file** —
> ideal for CI/CD.

## Motivation

A web service declares one real `domain` (`api.acme.com`). To stand up a staging
copy today you'd have to edit `launch-pad.toml` (a second service, a second
domain, a second node) — which CI can't do cleanly and which forces every
environment to be enumerated in the repo.

We want:

1. **Explicit prod domains stay explicit.** A service that needs a domain still
   declares its real production domain. No magic.
2. **One flag, any environment.** `launch-pad deploy --env staging` projects each
   web service's domain and runs a parallel, isolated footprint — no `.toml` edit.
3. **Total domain flexibility.** The projected domain can be *any* hostname shape:
   `api-staging.acme.com`, `staging.api.acme.com`, `api.staging.acme.com`,
   `testing-staging.agentsystem.dev`, `ui-staging.testing.agentsystem.dev`, … The
   author controls the layout via a pattern; `{env}` is the only required token.
4. **Environments are NOT enumerated in the repo.** No per-env blocks. One pattern
   covers every env.
5. **One shared edge fronts every environment.** prod + staging + dev all route
   through the same edge router with no edge-side changes.

## Locked decisions

- **`--env` is a deploy-time modifier**, like the existing `--service` / `--node`
  overrides — it changes what a deploy does without touching `launch-pad.toml`.
- **No `--env` ⇒ today's behavior exactly:** base project, literal `domain`,
  declared nodes. Full backward compatibility; the live `node-prod-1` is untouched.
- **Domain projection** via an optional `domainPattern` (service-level, or a
  project-level default) containing `{env}` (and optionally `{service}`). With no
  pattern, the default convention inserts `-<env>` after the first DNS label
  (`api.acme.com` → `api-staging.acme.com`).
- **Footprint namespacing:** with `--env <e>`, the deploy's *owner project* becomes
  `<project>-<e>`. That value is what drives the per-node replace key
  (`mergeProjectServices`), the container name (`launchpad_<project>_<service>_<i>`),
  capacity accounting, and the convergence watch — so prod and an env coexist with
  no collision.
- **ECR/build stay keyed on the base project.** Identical code → identical
  content-addressed tag → the env reuses the already-pushed image (no rebuild).
- **`LAUNCH_PAD_ENVIRONMENT`** is injected into each container's env when `--env` is set
  (a user-set value of the same key wins).
- **Edge is unchanged.** The projected domain flows into `ingress.domain`; the edge
  fronts whatever domains appear in desired state. `edge` (or the cluster default
  edge) is env-independent.

## Domain flexibility — worked examples

Prod domain `testing.agentsystem.dev`, deploying `--env dev`:

| Goal | `domainPattern` | `--env dev` →  |
|---|---|---|
| folded into the label | `testing-{env}.agentsystem.dev` | `testing-dev.agentsystem.dev` |
| nested under prod | `ui-{env}.testing.agentsystem.dev` | `ui-dev.testing.agentsystem.dev` |
| env as its own label | `{env}.testing.agentsystem.dev` | `dev.testing.agentsystem.dev` |
| project-wide (one pattern, every service) | top-level `{service}-{env}.testing.agentsystem.dev` | `api-dev…`, `ui-dev…` |
| (no pattern) default convention | — | `testing-dev.agentsystem.dev` |

The edge router is **structure-agnostic** — it host-matches the literal string and
auto-issues a cert per host regardless of nesting depth (verified against all three
shapes simultaneously through `caddy.buildConfig`). The only thing that varies with
domain shape is **DNS**, below.

## DNS — no Route53 required

Point a record at the edge's stable Elastic IP, once, at any provider:

- A single wildcard `*.agentsystem.dev → <edge EIP>` covers every **one-label**
  host (`testing.agentsystem.dev`, `testing-dev.agentsystem.dev`).
- DNS wildcards are single-label, so a **nested** shape
  (`ui-dev.testing.agentsystem.dev`) needs its own record:
  `*.testing.agentsystem.dev → <edge EIP>`, or a per-host A record.

TLS needs no DNS-01 and no wildcard cert: Caddy gets each host's cert via HTTP-01
as long as the host resolves to the edge. launch-pad never calls a DNS API.

## Placement — hybrid (chosen)

- **Default:** the env runs on the **same nodes** the service already declares,
  isolated only by the env-namespaced footprint. Zero per-env infra; CI just adds
  `--env`. Capacity (`assertCapacity`) correctly counts prod + every env on a shared
  node, so size the nodes for the sum or pin heavy envs elsewhere.
- **Opt-in isolation (Phase 1, no new code):** `deploy --env staging --node
  node-staging-app` pins that env to its own box — the existing `--node` override —
  with no `.toml` change.
- **Opt-in isolation (Phase 2):** a formal `env → nodes` map in operator config so
  CI doesn't repeat `--node`, and a natural seam to resolve `--env` to a cluster's
  nodes (keeps this orthogonal to `clusters-plan.md`: a **cluster** picks
  *placement + edge*; an **env** picks *footprint + domain*).

## Changes by package

### `packages/shared`

| File | Change |
|---|---|
| `config.ts` | Add `domainPattern?` to `ServiceDeclSchema` (web-only; must contain `{env}`; only `{env}`/`{service}` tokens) and a project-level `domainPattern?` default on `LaunchPadConfigSchema`. Add `envProject(project, env)`, `resolveServiceDomain(input, env)`, and `domainPatternError(pattern)` helpers. |
| `index.ts` | (already `export *`) — helpers exported automatically. |

`desired.ts` / `status.ts` are **unchanged**: `ingress.domain` and `project`
already carry the resolved values, which the CLI bakes in at deploy time. The
on-the-wire contract doesn't move.

### `packages/cli`

| File | Change |
|---|---|
| `commands/deploy.ts` | Add `--env <name>` (validated as a DNS label). Compute `ownerProject = envProject(project, env)` and thread it through `toServiceConfig`, capacity, `publishDesired`, and watch targets — **keep ECR on the base project**. Set each service's `resolved.domain` (and `BuiltService.domain`) via `resolveServiceDomain(...)`. Inject `LAUNCH_PAD_ENVIRONMENT`. Guard: the projected web domains in one deploy must be unique. Show projected URLs. |
| `commands/status.ts` | Add `--env <name>`; filter the rendered services to `envProject(project, env)`. |

### `packages/agent`

**No changes.** It reconciles whatever `desired.json` says, names containers from
the (now env-suffixed) project, and the edge fronts whatever domains exist.

## Backward compatibility

- No `--env` → base project + literal domain → byte-identical to today.
- `domainPattern` optional at both levels → existing configs parse unchanged.

## Test strategy

- **shared:** `resolveServiceDomain` (worker → undefined; no-env → literal; pattern
  with `{env}`/`{service}`; nested pattern; default `-<env>` insertion);
  `envProject`; schema rejects a pattern without `{env}`, an unknown token, and a
  pattern on a worker; project-level pattern parses.
- **cli:** projected-domain uniqueness guard; (deploy is AWS-bound, so the pure
  projection is covered in shared).

## Phased rollout

### Phase 1 — projection + namespacing, same-node default (this change)
domain projection, footprint namespacing, `LAUNCH_PAD_ENVIRONMENT`, uniqueness guard,
status filter, example, docs. Isolation via the existing `--node` override.

### Phase 2 — formal env→node mapping
operator-config `env → nodes` resolver (and the seam to resolve an env to a
cluster's nodes), so CI doesn't pass `--node` per environment.

## Open questions

- **`{env}` in env-var values** (e.g. `DB_NAME = "app_{env}"`) — easy follow-up,
  deferred to keep Phase 1 tight.
- **Per-env secrets / config inheritance** — out of scope; revisit if needed
  (mirrors the clusters-plan "environment stays emergent" stance).
