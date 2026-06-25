# LLM implementation prompt: Bring-your-own-server (BYOS) node init

> **How to use this file:** Paste the entire document (or the "Prompt" section below)
> into an LLM as the task specification. It describes what to build, what not to break,
> and how to phase the work. Read `docs/overview.md`, `docs/architecture.md`, and
> `CLAUDE.md` before implementing.

---

## Prompt

You are implementing **bring-your-own-server (BYOS) node enrollment** for
[Launch Pad](https://github.com/AgentSystemLabs/launch-pad) — a self-hosted deploy tool
where the CLI writes desired state to S3 and agents on nodes reconcile Docker + Caddy
to match.

### Product goal

Let users attach **servers they already own** (dedicated box, VPS, homelab, colo, another
cloud) to an existing Launch Pad cluster **without Launch Pad provisioning EC2**. A new CLI
command should:

1. Create least-privilege AWS credentials scoped to that node's S3 (and app-only ECR/SSM)
   permissions.
2. SSH into the user's machine.
3. Install and configure the Launch Pad agent (and Docker for app nodes, Caddy for edge
   nodes) so it polls S3 like a normal node.
4. Register the node in S3 (`node.json`) with correct capacity and routable IP metadata.
5. Wait for `status.json` heartbeat so the operator knows enrollment succeeded.

After enrollment, `launchpad deploy`, `rebalance`, `status`, and the placement scheduler
should treat the node like any other node in the pool (with documented limitations on
EC2-specific lifecycle commands).

### User personas

1. **Cost optimizer** — Wants cheaper app compute on own hardware; happy to keep the
   managed AWS edge (`edge-1`).
2. **Homelab / full self-host** — Wants **both** edge and app nodes on their own boxes;
   no EC2 at all.
3. **Hybrid** — Edge or apps on a dedicated public box; other tier stays in AWS VPC.

### Proposed CLI surface (names are suggestions — pick consistent naming)

```bash
# Enroll an external app node
launchpad node init \
  --host user@mybox.example \
  --role app \
  --edge edge-1 \
  --cpu 2048 \
  --memory 4096 \
  --advertise-ip 10.0.1.50 \
  [--name my-app-1] \
  [--ssh-key ~/.ssh/id_ed25519] \
  [--yes]

# Enroll an external edge node (power user)
launchpad node init \
  --host user@ingress.example.com \
  --role edge \
  --public-ip 203.0.113.10 \
  [--name edge-home] \
  [--yes]
```

Also support `--dry-run` (print plan: IAM actions, SSH steps, registry entry) and
`--json` for scripting.

**Do not** change the core deploy model: the CLI still never SSHes during `deploy` —
only during explicit `node init` enrollment.

---

## Functional requirements

### FR-1: Node enrollment command

- Add `launchpad node init` (or `node register --external` — choose one name and document
  it).
- Inputs:
  - `--host` (required): `user@hostname` for SSH.
  - `--role` (required): `app` | `edge`.
  - `--edge <nodeId>` (required when `--role app`): which edge routes to this app node.
  - `--advertise-ip` (required for app, or auto-detect with override): IP the **edge**
    uses to dial container host ports. Document that this must be reachable from the edge
    on TCP **20000–29999** (`HOST_PORT_MIN`–`HOST_PORT_MAX` in `packages/shared/src/constants.ts`).
  - `--public-ip` (required for edge): stable public IP for DNS / display (may match the
    box's primary IP).
  - `--cpu` / `--memory` (required): capacity in the same units as the registry
    (`cpu` = vCPU shares, 1024 = 1 vCPU; `memory` = MB). Used by placement and
    admission checks.
  - Optional: `--name` (node id; default generated name via `shared/src/node-names.ts`),
    `--ssh-key`, `--ssh-port`, `--agent-version`.
- Flow:
  1. Resolve cluster context (`AwsEnv` from existing CLI context).
  2. Create node identity (`nodeId`, `agentId`).
  3. Provision AWS credentials (see FR-2).
  4. Upload agent binary to S3 (reuse `provision/agent-bundle.ts`).
  5. SSH bootstrap (see FR-3).
  6. Write `node.json` to S3 with `instanceId: null` and a marker that this is an
     external node (see FR-4).
  7. Poll `status.json` until heartbeat is fresh (reuse deploy watch patterns).
  8. Print summary: node id, role, advertise IP, DNS hints for edge.

### FR-2: AWS credentials for external nodes

- Create **per-node least-privilege IAM** equivalent to today's instance-profile policies.
  Reuse the pure policy builders:
  - `buildAppPolicy` — app nodes (`packages/cli/src/aws/iam.ts`)
  - `buildEdgePolicy` — edge nodes
- Preferred approach (pick one and document tradeoffs):
  - **Option A:** IAM user per external node + access key, delivered to the box at init
    time (simplest for non-AWS hardware).
  - **Option B:** IAM role with external-id trust + `AssumeRole` from a bootstrap key
    (better for cross-account; more complex).
- Credentials on the box: install under `/etc/launch-pad/` with restrictive permissions;
  wire into the systemd unit via `EnvironmentFile` or the standard AWS SDK chain
  (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`).
- On `node destroy` for external nodes: revoke/delete the IAM user (or role session
  policy) in addition to existing S3 prefix cleanup in `teardownNode`.

### FR-3: SSH bootstrap

- Reuse existing bootstrap logic where possible:
  - `renderUserData` / `renderSystemdUnit` (`packages/cli/src/provision/user-data.ts`,
    `systemd-unit.ts`)
  - Agent config shape written to `/etc/launch-pad/agent.json` (same as cloud-init)
- Remote install steps (app role):
  - Ensure Docker is installed and running.
  - Install agent binary to `/opt/launch-pad/agent`.
  - Write systemd unit; `enable --now launch-pad-agent`.
  - Install AWS credentials.
- Remote install steps (edge role):
  - Ensure Caddy is installed (same as golden AMI / full bootstrap).
  - Install edge agent binary; no Docker.
- Target OS: **Linux with systemd** for MVP (Amazon Linux 2023, Ubuntu 22.04+). Fail with
  a clear error on unsupported distros rather than half-installing.
- Idempotency: re-running `node init` on an already-enrolled node should either no-op
  safely or error with a hint to use `node upgrade-agent`.
- SSH implementation: `ssh` subprocess or a small library — match repo style (no
  unnecessary deps unless justified).

### FR-4: Registry / wire contract

- Extend `NodeRegistryEntry` in `packages/shared/src/registry.ts` **additively** (use
  `.default()` for backward compatibility — no `PROTOCOL_VERSION` bump for registry-only
  fields):
  - `provisioning: "ec2" | "external"` (default `"ec2"`).
  - Optional: `advertiseIp` if different from `privateIp` / `publicIp` stored fields.
- External nodes:
  - `instanceId: null`
  - `securityGroupId: null` (unless user supplies metadata later)
  - `iamInstanceProfile: null` (use IAM user name or ARN in a new optional field if
    needed for destroy)
  - `state: "ready"` after successful heartbeat
- **Do not** bump `PROTOCOL_VERSION` unless `desired.json` / `status.json` shapes change.

### FR-5: Agent changes for non-EC2 hosts

Today the app agent discovers its upstream-shard IP via EC2 IMDSv2 only
(`packages/agent-rust/src/metadata.rs` → `get_private_ip()`). This **breaks** on
external hardware.

- Add override, in priority order:
  1. `LAUNCHPAD_ADVERTISE_IP` env var
  2. `advertiseIp` field in `/etc/launch-pad/agent.json` (extend agent config schema in
     shared + agent)
  3. Fall back to existing IMDSv2 lookup (EC2 path unchanged)
- Edge and app agents otherwise unchanged: default AWS credential chain already supports
  static keys.

### FR-6: Integration with existing commands

| Command | External node behavior |
|---------|------------------------|
| `deploy` / `rebalance` | Include in placement if `state: ready` and capacity allows |
| `deploy` auto-provision | Must **not** try to EC2-provision external nodes |
| `node list` / `show` | Show `provisioning: external`, no instance id |
| `node destroy` | Skip EC2 terminate/EIP/SG; delete IAM user + S3 prefix |
| `node pause` / `resume` / `resize` / `reconcile` | Refuse with clear error for external nodes |
| `node upgrade-agent` | SSH path (new) or document manual fallback (`manualUpgradeHint`) |
| `autoscale run` | Exclude external nodes from scale-out targets and scale-in victims |
| `doctor` | Warn if edge cannot reach app advertise IP (best-effort TCP check optional) |

### FR-7: Networking documentation (ship with feature)

Document operator responsibilities Launch Pad cannot automate:

- **App nodes:** Edge must reach `advertiseIp` on TCP 20000–29999. Same VPC, VPN,
  Tailscale, or routed LAN are valid; NAT hairpin may break health checks.
- **Edge nodes:** Public 80/443 open; DNS A/AAAA to stable public IP; **no CDN/proxy**
  in front of HTTP-01 / TLS-ALPN challenges (existing Let's Encrypt constraint).
- **Secrets (app only):** Box needs outbound HTTPS to AWS SSM and ECR in the cluster
  region.

---

## Non-functional requirements

- **Least privilege:** External node credentials must match existing per-node IAM scope
  (S3 desired read, status write, upstream shard write for app, etc.) — see
  `buildAppPolicy` / `buildEdgePolicy`.
- **No secrets in logs:** Never print access keys; redact in `--json` unless
  `--show-secrets` (if added, default off).
- **Tests:** Pure planners and policy generation via vitest; agent metadata override via
  `cargo test`. Mock SSH for init integration tests or test bootstrap script rendering
  in isolation.
- **Docs:** Update `docs/cli.md`, `docs/architecture.md`, and README table row if command
  surface changes.

---

## Architecture constraints — do not break

1. **S3 is the only shared contract** between CLI and agents. No new control-plane server.
2. **Push-based routing:** App agents write upstream shards; edge reads only its
   `upstream/*` prefix. No cross-node reads of `desired.json` / `status.json`.
3. **Roles:** `edge` = Caddy only, public ingress. `app` = Docker only, private. No `both`
   role for new nodes.
4. **Partial deploy semantics:** `mergeProjectServicesPartial` for subset deploys — unchanged.
5. **Config lock, capacity admission, sticky volumes, cron behavior** — unchanged.
6. **EC2 provisioning path** (`provisionNode`, `node create`, deploy auto-add) must keep
   working exactly as today for `provisioning: ec2` nodes.
7. **Additive schema changes only** for `node.json` and agent config unless protocol bump
   is explicitly required and documented.

---

## Phasing

### Phase 1 — MVP (ship this first)

- `node init` for **external app nodes** only.
- IAM user + access key delivery.
- SSH bootstrap on Linux/systemd.
- Agent `advertiseIp` override.
- Registry `provisioning: external`.
- Guard EC2-only commands.
- Basic docs.

**Success criteria:**

- External app node enrolls, publishes `status.json` heartbeat, receives placements from
  `deploy`, pulls from ECR, resolves SSM secrets, publishes upstream shards.
- Existing AWS-only clusters and tests pass unchanged.

### Phase 2 — External edge

- `node init --role edge` with Caddy bootstrap.
- `cluster set-edge` / deploy works with external edge as `ingress.edge`.
- DNS panel output points at user-managed IP.
- Doctor checks for 80/443 and edge→app reachability.

### Phase 3 — Polish (optional)

- SSH-based `node upgrade-agent`.
- Credential rotation command.
- `--advertise-ip` auto-detect over SSH with confirm prompt.
- Ubuntu + AL2023 bootstrap matrix in CI.

---

## Out of scope (unless explicitly requested)

- Non-Linux agents (Windows, macOS).
- Launch Pad managing VPN/Tailscale/WireGuard.
- CDN or Cloudflare integration for external edges.
- Running agents without AWS at all (S3-compatible alternate backend).
- Replacing EC2 auto-provision as the default onboarding path.

---

## Key files to read first

| Area | Path |
|------|------|
| North star | `docs/overview.md`, `docs/architecture.md` |
| Repo map | `docs/codebase-layout.md`, `CLAUDE.md` |
| Node registry schema | `packages/shared/src/registry.ts` |
| IAM policies | `packages/cli/src/aws/iam.ts` |
| EC2 provision | `packages/cli/src/provision/provision-node.ts` |
| Cloud-init bootstrap | `packages/cli/src/provision/user-data.ts` |
| Node commands | `packages/cli/src/commands/node/index.ts` |
| Deploy placement | `packages/cli/src/deploy/placement.ts` |
| Agent AWS + metadata | `packages/agent-rust/src/aws.rs`, `metadata.rs` |
| Upstream shards | `packages/agent-rust/src/upstream.rs`, `packages/shared/src/edge.ts` |
| Manual upgrade hint | `packages/cli/src/provision/upgrade-agent.ts` |

---

## Acceptance test scenarios

1. **Enroll external app node** on a Linux host reachable from the cluster edge; run
   `deploy` for a web service; verify HTTPS via edge and `status` shows running replicas.
2. **Enroll external app worker** (no domain); verify container runs, no upstream shard
   required.
3. **Destroy external node** — IAM user removed, S3 prefix gone, no EC2 API calls.
4. **Pause on external node** — fails with actionable error.
5. **Deploy with auto-add** — does not spawn EC2 when external nodes have capacity.
6. **EC2 regression** — existing `node create` + `deploy` e2e / unit tests still pass.
7. **Agent on EC2** — IMDS path still used when no `advertiseIp` override set.

---

## Open decisions (resolve in implementation PR description)

1. IAM user vs cross-account role for credentials?
2. `node init` vs `node register` + `node bootstrap` as two commands?
3. Store `advertiseIp` only in agent config, or also denormalize into `node.json`?
4. Minimum supported distros and package managers for SSH bootstrap?
5. Should `doctor` actively probe edge→app:port or only print static guidance?

---

## Definition of done

- [ ] `launchpad node init` works for external app nodes (Phase 1).
- [ ] Agent reads `advertiseIp` / env override on non-EC2 hosts.
- [ ] `node.json` marks external nodes; placement and deploy include them.
- [ ] EC2-only lifecycle commands fail gracefully for external nodes.
- [ ] IAM cleanup on destroy.
- [ ] Tests for new pure logic + agent metadata override.
- [ ] `docs/cli.md` and `docs/architecture.md` updated.
- [ ] No `PROTOCOL_VERSION` bump unless justified.
