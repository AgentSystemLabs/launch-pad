# Example: nested env domains (`ui-<name>.multi.agentsystem.dev`)

Production uses a **delegated zone** under `agentsystem.dev`. Named environments nest
the env label **before** the zone label (`ui-<name>.multi…`), not as a sibling of `multi`
(`<name>.multi…`).

```
  multi.agentsystem.dev ────────┐
  api.multi.agentsystem.dev ────┤
  ui-<name>.multi.agentsystem.dev┼──▶ node-edge (edge) ──VPC──▶ node-app
  api-<name>.multi… ────────────┘
```

## Projected domains

| Deploy | `--env` | `ui` | `api` |
| ------ | ------- | ---- | ----- |
| production | *(omit)* | `multi.agentsystem.dev` | `api.multi.agentsystem.dev` |
| named env | `<name>` | `ui-<name>.multi.agentsystem.dev` | `api-<name>.multi.agentsystem.dev` |

Example: `--env preview` → `ui-preview.multi.agentsystem.dev` and `api-preview.multi.agentsystem.dev`.

## DNS — two records on the edge EIP

DNS wildcards cover **one** label. `*.agentsystem.dev` matches `api.multi.agentsystem.dev`
but **not** `ui-preview.multi.agentsystem.dev` (two labels under `multi`).

Point both at the **edge** Elastic IP from `node create node-edge`:

| Type | Name / host | Resolves |
| ---- | ----------- | -------- |
| `A` | `multi.agentsystem.dev` | production UI apex |
| `A` | `*.multi.agentsystem.dev` | `ui-<name>.multi…`, `api-<name>.multi…` |

`api.multi.agentsystem.dev` is one label under `agentsystem.dev`, so it is also covered
by an optional third record if you use other hosts on the same zone:

| Type | Name / host | Resolves |
| ---- | ----------- | -------- |
| `A` | `*.agentsystem.dev` | `api.multi.agentsystem.dev` and any other `*.agentsystem.dev` one-label host |

Caddy obtains a **per-host** certificate via HTTP-01 — no wildcard TLS cert required.

## Launch (from this directory)

Deploy resolves `launch-pad.toml` from **`process.cwd()`**, so run every command
**inside** `examples/edge-1-app-deploy-env-nested-multi-dns` (not from the repo root or `packages/cli`).

### Prerequisites

- Node ≥ 24, Docker running (for real deploys — build + push).
- AWS credentials with permission to use EC2, ECR, IAM, S3 in your target region
  (`aws sts get-caller-identity` should succeed).
- Optional: `~/.launch-pad/config.toml` default cluster/region; otherwise pass
  `--region us-east-1` (and `--cluster <name>` if not `default`).

### 1. Verify auto-provisioning (no EC2 spend)

With **no** `node-edge` / `node-app` in S3 yet, deploy prints a provisioning plan and
creates nothing:

```bash
cd examples/edge-1-app-deploy-env-nested-multi-dns

# monorepo (from repo root path shown; adjust if you cloned elsewhere)
node --import tsx/esm ../../packages/cli/src/index.ts deploy --dry-run

# or published CLI
npx @agentsystemlabs/launch-pad deploy --dry-run
```

Expect a panel like:

```
+ create node-edge edge · t3.small
+ create node-app  app · t3.small
```

Edges are planned **before** app nodes (app SG references the edge). If a node already
exists, you may see `ready` or `resume` instead of `create`. Use `--json` for machine-readable
`provision.create` / `provision.repair`.

To **require** pre-created nodes (old behavior): `deploy --no-create` errors when a node is missing.

### 2. Deploy production (auto-creates missing nodes)

```bash
node --import tsx/esm ../../packages/cli/src/index.ts deploy --yes
# npx @agentsystemlabs/launch-pad deploy --yes
```

- **`--yes`** skips the "provision N node(s)?" prompt (needed in CI; recommended when
  you intend to create instances).
- Without `--yes`, deploy prompts before launching EC2.
- Creates `node-edge` then `node-app` if missing; builds/pushes images; writes
  `desired.json`; watches `status.json` until the agent converges.

### 3. Deploy named environments (same nodes, no new infra)

```bash
node --import tsx/esm ../../packages/cli/src/index.ts deploy --env preview --yes
node --import tsx/esm ../../packages/cli/src/index.ts deploy --env qa --yes
```

No extra nodes — only new footprints on `node-app` and new routes on `node-edge`.

### 4. DNS (after the edge exists)

```bash
node --import tsx/esm ../../packages/cli/src/index.ts node show node-edge
```

Use the printed **Elastic IP** for the records in [DNS — two records](#dns--two-records-on-the-edge-eip) above.

### 5. Confirm nodes exist

```bash
node --import tsx/esm ../../packages/cli/src/index.ts node list
node --import tsx/esm ../../packages/cli/src/index.ts status
node --import tsx/esm ../../packages/cli/src/index.ts status --env preview
curl -s https://ui-preview.multi.agentsystem.dev/
```

### Manual provisioning (optional)

You can still pre-create nodes; deploy will show `ready` and skip create:

```bash
launch-pad node create node-edge --role edge
launch-pad node create node-app  --role app --edge node-edge
```

Footprints `multi`, `multi-preview`, and `multi-qa` coexist on `node-app`. The edge adds
a route per projected hostname.

## How the TOML maps to DNS

| Service | Production `domain` | `domainPattern` | Why |
| ------- | ------------------- | --------------- | --- |
| `ui` | `multi.agentsystem.dev` | `ui-{env}.multi.agentsystem.dev` | production apex; envs under `ui-<name>.multi…` |
| `api` | `api.multi.agentsystem.dev` | *(project default)* `{service}-{env}.multi…` | `api-<name>.multi…` |

Contrast [`../edge-1-app-deploy-env-shop-domains`](../edge-1-app-deploy-env-shop-domains) (flat `<name>.shop.example.com`) and
[`../edge-1-app-deploy-env-flat-domains`](../edge-1-app-deploy-env-flat-domains) (flat `<name>.agentsystem.dev`).

See [`../README.md`](../README.md) for the full examples matrix.
