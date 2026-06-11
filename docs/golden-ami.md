# Golden AMI & node provisioning

How a fresh EC2 instance becomes a Launch Pad node, and how the prebaked **golden AMI**
makes that fast.

## Why a golden AMI

The fallback bootstrap (plain Amazon Linux 2023) installs Docker, Caddy, the CloudWatch
Agent, Node.js, and the agent bundle on **every** first boot — slow and dependent on package
mirrors. The golden AMI bakes all of that in once, so first boot only writes node-specific
config and starts services.

## What's baked in

The Packer template ([`infra/packer/golden-ami.pkr.hcl`](../infra/packer/golden-ami.pkr.hcl))
builds from the latest Amazon Linux 2023 (x86_64) and installs:

- **Docker**
- **Caddy** (static binary)
- **Amazon CloudWatch Agent**
- **Node.js 22**
- **The Launch Pad agent** — the TypeScript bundle at `/opt/launch-pad/agent.cjs`
- Pre-created directories: `/etc/launch-pad`, `/var/lib/launch-pad`, `/opt/launch-pad`,
  `/var/log/launch-pad`

The AMI is tagged `AgentType: ts` + `AgentVersion: <version>` so tooling can identify it.

## Building the AMI

```bash
pnpm build:golden-ami        # runs scripts/build-golden-ami.sh
```

The script (requires **Packer** and ambient AWS credentials; region defaults to `us-east-1`):

1. Builds the workspace (`pnpm build`) to produce `packages/agent/dist/index.cjs`.
2. Runs `packer init` + `packer build`, passing the bundle path and agent version.
3. Post-processes Packer's `infra/packer/latest-manifest.json` via
   [`scripts/update-golden-ami-manifest.mjs`](../scripts/update-golden-ami-manifest.mjs),
   writing the per-region AMI id into
   [`packages/cli/src/provision/golden-ami-manifest.json`](../packages/cli/src/provision/golden-ami-manifest.json).

That manifest is **committed** — it's how the CLI knows which golden AMI to use per region.

## How the CLI picks an AMI

`resolveNodeAmi()` ([`packages/cli/src/provision/golden-ami.ts`](../packages/cli/src/provision/golden-ami.ts))
resolves in precedence order:

| Priority | Source | Bootstrap mode (default) |
| -------- | ------ | ------------------------ |
| 1 | `--ami <id>` flag | `full` (assumed not a golden image) |
| 2 | `LAUNCHPAD_AMI_ID` env var | `golden` (assumed your own golden build) |
| 3 | Golden manifest entry for the region (verified `available` via EC2 `DescribeImages`) | `golden` |
| 4 | Latest Amazon Linux 2023 (via SSM public parameter) | `full` |

`LAUNCHPAD_AMI_BOOTSTRAP=full|golden` overrides the bootstrap mode in any case — set
`LAUNCHPAD_AMI_BOOTSTRAP=full` if your custom `LAUNCHPAD_AMI_ID` is *not* a Launch Pad
golden image.

## Bootstrap modes

The agent is **not distributed via npm** — the bundle is uploaded to S3 (for upgrades) and
either baked into the golden AMI or downloaded via presigned URL on full bootstrap.

| Bootstrap | What cloud-init does |
| --------- | -------------------- |
| **golden** | Verifies preinstalled Docker, Node, and `/opt/launch-pad/agent.cjs`; **no agent download**. Still uploads the bundle to S3 for `node upgrade-agent`. |
| **full** | Installs Docker, Caddy, Node.js 22, and CloudWatch Agent via dnf; curls the agent bundle from a presigned S3 URL. |

The generated **systemd unit** (`packages/cli/src/provision/systemd-unit.ts`) runs
`node /opt/launch-pad/agent.cjs`, restarts always, and waits for Docker + network. New nodes
are recorded in the registry with `agentType: "ts"`.

## Operational gotchas

- `user_data.sh` runs `set -euxo pipefail` — any failed command aborts cloud-init and the
  agent never installs. Diagnose a no-show agent via EC2 console output / a missing
  `status.json`.
- The node IAM policy must include `s3:ListBucket` on the state bucket, or `GetObject` on a
  not-yet-existing `desired.json` returns 403 (not 404) and a fresh node can't reconcile.
- CI can pin an AMI with `LAUNCHPAD_AMI_ID` (+ `LAUNCHPAD_AMI_BOOTSTRAP=full` when it's not
  a golden image).
- After removing the Rust agent, run `pnpm build:golden-ami` to publish a new TS golden AMI
  before relying on the committed manifest entries.
