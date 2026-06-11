# Golden AMI & node provisioning

How a fresh EC2 instance becomes a Launch Pad node, and how the prebaked **golden AMI**
makes that fast.

## Why a golden AMI

The fallback bootstrap (plain Amazon Linux 2023) installs Docker, Caddy, the CloudWatch
Agent, and an agent runtime on **every** first boot — slow and dependent on package mirrors.
The golden AMI bakes all of that in once, so first boot only writes node-specific config and
starts services.

## What's baked in

The Packer template ([`infra/packer/golden-ami.pkr.hcl`](../infra/packer/golden-ami.pkr.hcl))
builds from the latest Amazon Linux 2023 (x86_64) and installs:

- **Docker**
- **Caddy** (static binary)
- **Amazon CloudWatch Agent**
- **Node.js 22** (so the TS agent can run if selected)
- **The Rust Launch Pad agent** — a static `x86_64-unknown-linux-musl` binary at
  `/opt/launch-pad/agent`
- Pre-created directories: `/etc/launch-pad`, `/var/lib/launch-pad`, `/opt/launch-pad`,
  `/var/log/launch-pad`

The AMI is tagged `AgentType: rust` + `AgentVersion: <version>` so tooling can identify it.

## Building the AMI

```bash
pnpm build:golden-ami        # runs scripts/build-golden-ami.sh
```

The script (requires **Packer**, **cargo** with **cargo-zigbuild**, and ambient AWS
credentials; region defaults to `us-east-1`):

1. Cross-compiles the Rust agent: `cargo zigbuild --release --target x86_64-unknown-linux-musl`.
2. Runs `packer init` + `packer build`, passing the binary path and agent version.
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

## Bootstrap modes & agent runtimes

Two agent runtimes exist (see [agent.md](agent.md)): the production **TypeScript agent**
(bundled to a single self-contained CJS file) and the **Rust agent** (static binary). The
agent is **not distributed via npm** — artifacts are uploaded to S3 and fetched by
cloud-init via presigned URL, except when already baked into the golden AMI.

Defaults: golden AMI → `rust`, full bootstrap → `ts`. Override with `--agent rust|ts` on
`node create` / `deploy`.

| Bootstrap × runtime | What cloud-init does |
| ------------------- | -------------------- |
| golden + rust (default on golden) | Verifies preinstalled Docker + `/opt/launch-pad/agent`; **no downloads**. |
| golden + ts | Downloads the TS CJS bundle from S3; Node 22 already baked. |
| full + rust | Installs Docker/Caddy via dnf; downloads the Rust binary from S3 (no Node needed). |
| full + ts (default on full) | Installs Docker/Caddy + Node.js 22; downloads the CJS bundle from S3. |

The generated **systemd unit** (`packages/cli/src/provision/systemd-unit.ts`) runs
`/opt/launch-pad/agent` (rust) or `node /opt/launch-pad/agent.cjs` (ts), restarts always,
and waits for Docker + network. The chosen `agentType` is recorded in the node's registry
entry so instance replacement reuses it.

## Operational gotchas

- `user_data.sh` runs `set -euxo pipefail` — any failed command aborts cloud-init and the
  agent never installs. Diagnose a no-show agent via EC2 console output / a missing
  `status.json`.
- The node IAM policy must include `s3:ListBucket` on the state bucket, or `GetObject` on a
  not-yet-existing `desired.json` returns 403 (not 404) and a fresh node can't reconcile.
- CI can pin an AMI with `LAUNCHPAD_AMI_ID` (+ `LAUNCHPAD_AMI_BOOTSTRAP=full` when it's not
  a golden image).
