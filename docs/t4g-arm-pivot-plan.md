# t4g / ARM Pivot Plan

## Goal

Make new Launch Pad clusters default to cheaper Graviton-backed EC2 nodes while keeping existing x86 clusters and services safe.

Target defaults:

- Edge node: `t4g.nano`
- First app node: `t4g.micro`, auto-sized up when service reservations require it

Users should still be able to choose any valid EC2 instance type for edge or app nodes.

## Status

Implemented in the codebase:

- `node.json` carries additive `architecture` metadata, defaulting legacy entries to `x86_64`.
- New auto-provisioned clusters default to `t4g.nano` edge nodes and ARM app sizing from a `t4g.micro` floor.
- AMI lookup, agent binary selection, Caddy bootstrap, local Docker builds, and CodeBuild remote builds are architecture-aware.
- Existing x86 pools keep x86 scale-out behavior, and in-place resize refuses cross-architecture changes.
- The real-AWS `e2e:empty-cluster` harness verifies the ARM/T4G bootstrap in a random named cluster with a temporary `LAUNCHPAD_HOME`.

## Current Blockers

The codebase already treats instance type mostly as data, but several architecture assumptions are currently hard-coded:

- AMI resolution falls back to Amazon Linux 2023 `x86_64` only.
- Golden AMI manifest entries are keyed by role + region, not architecture.
- Packer templates build x86 AMIs only.
- Rust agent binaries are built only for `x86_64-unknown-linux-musl`.
- Caddy downloads use `arch=amd64`.
- Local and remote Docker builds publish only `linux/amd64` images.
- Capacity defaults and cost estimates know about `t3.*`, not `t4g.*`.

## Safety Constraints

- Do not mutate existing nodes automatically.
- Do not resize `t3` nodes to `t4g` in place. EC2 cross-architecture changes need recreate/migration behavior, not stop/modify/start.
- Preserve existing x86 clusters. Auto-added nodes in an existing app pool should inherit that pool's architecture unless the user explicitly migrates.
- Keep app placements homogeneous for the first implementation. If a service would span x86 and ARM app nodes, fail early with a clear error.
- Use isolated e2e clusters with random names and temporary `LAUNCHPAD_HOME` so existing Launch Pad services are not touched.

## Implementation Plan

1. Add architecture as first-class node metadata.
   - Add `architecture: "x86_64" | "arm64"` to `NodeRegistryEntrySchema`, defaulting old `node.json` files to `x86_64`.
   - Teach instance-type resolution to return both capacity and architecture from `DescribeInstanceTypes`.
   - Add `t4g.*` entries to the shared capacity table.

2. Make defaults Graviton-aware.
   - Change `DEFAULT_EDGE_INSTANCE_TYPE` to `t4g.nano`.
   - Change app auto-size floor from `t3.small` to `t4g.micro`, while preserving auto-sizing for larger service demand.
   - Update autoscale scale-out defaults to choose an architecture-compatible app node type.

3. Make AMI selection architecture-aware.
   - Resolve latest AL2023 via:
     - `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`
     - `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`
   - Change golden AMI lookup to role + region + architecture.
   - Update the manifest schema and migration defaults without breaking old empty manifests.

4. Build and distribute role + architecture agent binaries.
   - Build both `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`.
   - Store artifacts with architecture in the path/name, for example `dist/x86_64/agent-app` and `dist/arm64/agent-app`.
   - Upload the binary matching the node's role and architecture during provision and upgrade.

5. Make edge bootstrap architecture-aware.
   - Render Caddy download URLs with `arch=amd64` or `arch=arm64`.
   - Update full bootstrap, external bootstrap, and Packer edge templates.

6. Make app image builds match placement architecture.
   - Use `linux/arm64` when a service is placed on ARM app nodes.
   - Keep `linux/amd64` for existing x86 app nodes.
   - Reject mixed app-node architectures for a single service in this first implementation.
   - Update remote CodeBuild buildspec generation to receive the target platform.

7. Add migration-safe command behavior.
   - Make `node resize --instance-type t4g.*` refuse cross-architecture in-place resize with guidance to add an ARM node, rebalance/evacuate, then destroy old x86 nodes.
   - Keep explicit `node create --instance-type ...` working for both x86 and ARM by selecting the matching AMI and agent binary.

8. Update tests and docs.
   - Unit tests for architecture parsing, AMI resolution, Caddy download arch, agent artifact selection, Docker platform selection, capacity defaults, autoscale defaults, and mixed-architecture rejection.
   - Docs updates in `README.md`, `docs/golden-ami.md`, `docs/agent.md`, `docs/architecture.md`, `docs/cli.md`, and `docs/testing.md`.

## Verification Plan

Add an isolated real-AWS e2e test based on `e2e/src/empty-cluster.ts`:

1. Use a random named cluster, not `default`.
2. Use a temporary `LAUNCHPAD_HOME`.
3. Provision one `t4g.nano` edge node and one `t4g.micro` app node.
4. Deploy the tiny worker fixture as `linux/arm64`.
5. Assert:
   - edge node exists, role `edge`, architecture `arm64`
   - app node exists, role `app`, architecture `arm64`
   - both agents publish status
   - worker container reaches `running`
   - second deploy is idempotent
6. Always run `cluster destroy <random-cluster> --yes` in teardown unless `--keep` is explicitly passed.

## Expected Refactor Size

Moderate. The scheduler/provisioning model already has good boundaries around instance type and capacity. The main work is making architecture explicit where it is currently implicit:

- AMI selection
- agent artifact selection
- edge bootstrap
- app image build platform
- safe default selection

No protocol version bump should be needed because `architecture` can be additive/defaulted in `node.json`, and the agent does not need it in `desired.json`.
