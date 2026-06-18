# Golden AMIs & node provisioning

How a fresh EC2 instance becomes a Launch Pad node, and how the prebaked **role-specific
golden AMIs** make that fast and lean.

## Why two golden AMIs

The fallback bootstrap (plain Amazon Linux 2023) installs a node's stack on **every** first
boot — slow and dependent on package mirrors. The golden AMIs bake it in once, so first
boot only writes node-specific config and starts services.

The AMIs are **role-specific** because the two node roles need disjoint stacks — an edge
node never runs containers and an app node never runs Caddy:

| | **Edge AMI** | **App AMI** |
| --- | --- | --- |
| Caddy (static binary) | ✓ | — |
| Docker | — | ✓ |
| Amazon CloudWatch Agent | ✓ | ✓ |
| Launch Pad agent at `/opt/launch-pad/agent` | `launchpad-agent-edge` | `launchpad-agent-app` |
| Node.js | — | — |

No Node.js anywhere: the agent is a self-contained Rust binary (~11 MB static). Cutting
Docker + Node.js from the edge frees the ~150–300 MB they idled at, so the default
**t3.nano** edge (512 MB) runs with comfortable headroom — target steady state is **< 400 MB
used** (OS + SSM + CloudWatch + Caddy + agent). `t3.micro` (1 GB) remains plenty of margin
if you size up manually.

Both AMIs build from the **standard** AL2023 base (not "minimal") — it ships the SSM agent
that `launchpad node upgrade-agent` and `node monitor` depend on.

AMIs are tagged `LaunchPadRole: edge|app`, `AgentType: rust`, `AgentVersion: <version>` so
tooling can identify them.

## Building the AMIs

```bash
pnpm build:golden-ami        # runs scripts/build-golden-ami.sh — builds BOTH AMIs
bash scripts/build-golden-ami.sh edge   # just one role
```

The script (requires **Packer**, the **Rust toolchain** (+ `cargo-zigbuild` off-Linux), and
ambient AWS credentials; region defaults to `us-east-1`):

1. Builds the agent binaries if missing (`scripts/build-agent-binaries.sh` →
   `packages/agent-rust/dist/agent-{edge,app}`, linux/amd64 static musl).
2. Runs `packer init` + `packer build` per role
   ([`infra/packer/golden-ami-edge.pkr.hcl`](../infra/packer/golden-ami-edge.pkr.hcl) /
   [`golden-ami-app.pkr.hcl`](../infra/packer/golden-ami-app.pkr.hcl)).
3. Post-processes each Packer manifest via
   [`scripts/update-golden-ami-manifest.mjs`](../scripts/update-golden-ami-manifest.mjs),
   writing the per-role, per-region AMI id into
   [`packages/cli/src/provision/golden-ami-manifest.json`](../packages/cli/src/provision/golden-ami-manifest.json).

That manifest is **committed** — it's how the CLI knows which golden AMI to use per role +
region (`amis.edge[region]` / `amis.app[region]`, schema v2).

## How the CLI picks an AMI

Role → AMI selection is **automatic** — users never choose between edge/app images unless
they opt in with `--ami`. `resolveNodeAmi()`
([`packages/cli/src/provision/golden-ami.ts`](../packages/cli/src/provision/golden-ami.ts))
resolves by **role + region**, in precedence order:

| Priority | Source | Bootstrap mode (default) |
| -------- | ------ | ------------------------ |
| 1 | `--ami <id>` flag | `full` (assumed not a golden image) |
| 2 | `LAUNCHPAD_AMI_ID` env var (applies to both roles) | `golden` (assumed your own golden build) |
| 3 | Golden manifest entry for the node's role + region (verified `available`) | `golden` |
| 4 | Latest Amazon Linux 2023 (via SSM public parameter) | `full` (role-appropriate bootstrap) |

`LAUNCHPAD_AMI_BOOTSTRAP=full|golden` overrides the bootstrap mode in any case — set
`LAUNCHPAD_AMI_BOOTSTRAP=full` if your custom `LAUNCHPAD_AMI_ID` is *not* a Launch Pad
golden image.

## Bootstrap modes

The agent is **not distributed via npm** — the role-specific binary is uploaded to S3
(`nodes/<id>/agent`, also used by upgrades) and either baked into the golden AMI or
downloaded via presigned URL on full bootstrap.

| Bootstrap | What cloud-init does |
| --------- | -------------------- |
| **golden** | Verifies the preinstalled stack (`test -x /opt/launch-pad/agent`, Caddy on edge, enables Docker on app); **no agent download**. Still uploads the binary to S3 for `node upgrade-agent`. |
| **full** | Installs the role's stack via dnf (edge: Caddy + CloudWatch Agent; app: Docker + CloudWatch Agent); curls the agent binary from a presigned S3 URL and `chmod +x`s it. |

The generated **systemd unit** (`packages/cli/src/provision/systemd-unit.ts`) runs
`/opt/launch-pad/agent`, restarts always; only the **app** unit waits for
`docker.service` (the edge AMI has no Docker at all). New nodes are recorded in the
registry with `agentType: "rust"`.

## Operational gotchas

- `user_data.sh` runs `set -euxo pipefail` — any failed command aborts cloud-init and the
  agent never installs. Diagnose a no-show agent via EC2 console output / a missing
  `status.json`.
- The node IAM policy must include `s3:ListBucket` on the state bucket, or `GetObject` on a
  not-yet-existing `desired.json` returns 403 (not 404) and a fresh node can't reconcile.
- A wrong-AMI-for-role mistake fails closed at first tick: the app binary exits loudly when
  Docker is missing, and either binary refuses a role-mismatched `agent.json` — check
  `launchpad logs` / the node's system log group rather than hunting silence.
- CI can pin an AMI with `LAUNCHPAD_AMI_ID` (+ `LAUNCHPAD_AMI_BOOTSTRAP=full` when it's not
  a golden image) — note a single env AMI applies to **both** roles.
- After switching to the Rust agent, run `pnpm build:golden-ami` once to publish the new
  role-specific AMIs before relying on the committed manifest entries.
