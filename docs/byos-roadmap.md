# BYOS follow-up roadmap

Bring-your-own-server (BYOS) **Phase 1** (external **app** nodes) is implemented and
verified end-to-end against real AWS (enroll → static-cred agent → heartbeat → deploy a
worker pulled from ECR → pause-guard → clean `node destroy` with zero EC2 calls). See
`docs/byos-node-init-prompt.md` for the original spec and `docs/cli.md` / `docs/architecture.md`
for the shipped surface.

This file tracks the gaps that remain before BYOS is **production-grade**. Each item is
grounded in current code (file:line refs verified 2026-06-20). Work top-down: each phase
makes the previous one safer to rely on.

Legend: 🟥 blocks real production use · 🟧 correctness / rough edge · 🟦 scope/feature gap

---

## Phase 1 — Operability: make a live BYOS node observable & safe

> Goal: an operator running real workloads on a BYOS node can see logs, isn't silently
> wedged by a dead box, and gets an honest cost number. These are the "what we shipped is
> usable in prod" items.

### 1. 🟥 Logs / observability for BYOS nodes

**Problem:** BYOS nodes ship no centralized logs. `node install-logging` skips external
nodes and the CloudWatch-Agent install (`renderCloudWatchInstall`) never runs in the BYOS
bootstrap, so the agent's per-tick log sync errors **every tick**
(`packages/agent-rust/src/cloudwatch_logs.rs:102,112,118` → `log sync failed (continuing)`).
The operator gets zero `launchpad`-visible logs and a spammy journal. The node's own creds
*already* allow `logs:CreateLogGroup/CreateLogStream/PutLogEvents`
(`packages/cli/src/aws/iam.ts:145-147`).

- [x] **1a (now, cheap):** agent treats "no CloudWatch log pipeline present" as a supported
      no-op — skip the sync, log once at startup, stop erroring every tick
      (`packages/agent-rust/src/cloudwatch_logs.rs`).
- [x] **1b (real fix):** have the launchpad agent ship container + agent logs **directly** to
      CloudWatch Logs via the SDK (no dependency on the separate CloudWatch Agent). Reuses the
      existing `logs:*` grant — no IAM change. Cleaner for EC2 nodes too.
- [x] **1c:** document the BYOS logging story (`docs/cli.md` / `docs/agent.md`): BYOS logs ship
      through the agent; pre-direct-log nodes can still be inspected locally with
      `journalctl -u launch-pad-agent` and `docker logs`.
- **Done when:** a BYOS node's journal is quiet on a healthy tick, and (after 1b)
      `launchpad`-side log viewing works for BYOS containers identically to EC2.

### 2. 🟥 Liveness-aware placement & dead-node reaping

**Problem:** `deploy.ts` has **no heartbeat/liveness gate** and `candidate-nodes.ts:65`
admits a node by **role only** (not state, not heartbeat freshness). For EC2 a dead box is
caught by `node reconcile` + EC2 drift (`describeInstances`); a BYOS box has no EC2 to
describe, so a dead external node stays `state: ready`, remains a placement target, **hangs
every deploy** that lands a service there, and nothing reaps it (`node reconcile` skips
`instanceId: null`; autoscale excludes external from scale-in).

- [x] **2a:** exclude stale-heartbeat external nodes from placement — read `status.json`
      `lastSeen` and skip when `isHeartbeatStale(...)` for `provisioning: "external"` nodes
      in `buildCandidateNodes` (`packages/cli/src/deploy/candidate-nodes.ts`). Pure-testable.
- [x] **2b:** surface a dead external node in `node list` / `doctor` (stale-heartbeat warning)
      and in `status`.
- [x] **2c:** give external nodes a cordon/auto-drain path — a long-dead external node should
      be drainable (`rebalance --drain`) and droppable without `node destroy` racing live state.
- [x] **2d:** unit tests for the stale-node placement filter (mock `status.json` lastSeen).
- **Done when:** a powered-off BYOS node no longer wedges `deploy`, and the operator gets a
      clear "node X heartbeat is stale" signal.

### 3. 🟧 Cost rollup honesty for external nodes

**Problem:** `summarizeClusterCost` counts every `ready`/`provisioning` node as EC2-billing
(`packages/cli/src/cost/estimate.ts:286`) and `lookupHourlyUsd("external")` returns `null`
(`:98`), so **one BYOS node flips the whole-cluster total to "unknown (EC2 rate missing)"**.

- [x] **3a:** external nodes are `billsEc2: false` (operator pays $0 EC2) — surface S3/agent
      cost only; don't poison the cluster total (`packages/cli/src/cost/estimate.ts`).
- [x] **3b:** `node list` / cost output labels external nodes as "external (no EC2 cost)".
- [x] **3c:** test: a cluster with 1 EC2 + 1 external node yields a known total.
- **Done when:** adding a BYOS node never makes the cost estimate read "unknown".

---

## Phase 2 — Lifecycle & web workloads

> Goal: web apps (the cost-optimizer persona's actual use case) work reliably, and an
> enrolled node can be maintained over time.

### 4. 🟥 Edge → app reachability probe

**Problem:** the web-through-edge path is untested and unvalidated. `node init` never checks
that the edge can reach `advertiseIp` on TCP 20000–29999 (`HOST_PORT_MIN..MAX`), and `doctor`
only prints static text. A wrong `--advertise-ip`, a missing SG/firewall rule, or NAT
hairpin = silent 502s and replicas that never pass the edge health check.

- [x] **4a:** at the end of `node init`, run an active reachability check edge → advertiseIp
      on a sample host port (best-effort; warn, don't hard-fail) before declaring success
      (`packages/cli/src/commands/node/init.ts`).
- [x] **4b:** `doctor` actively probes edge → each external app node's advertiseIp on the host
      port range and reports unreachable nodes (`packages/cli/src/commands/doctor.ts`).
- [ ] **4c:** real-AWS validation of a **web** service on a BYOS app node (HTTPS via the edge,
      rolling update stays zero-downtime, health checks pass).
- [x] **4d:** doc the reachability requirement + NAT-hairpin caveat with a concrete checklist.
- **Done when:** a misconfigured advertiseIp surfaces as an actionable enroll-time/doctor
      error instead of a runtime 502, and a web service on BYOS is verified live.

### 5. 🟧 SSH-based `node upgrade-agent` for external nodes

**Problem:** `node upgrade-agent` is SSM-based and skips external nodes — once enrolled, a
BYOS agent can only be updated by manual SSH. Agent bugfixes can't reach BYOS fleets.

- [x] **5a:** add an SSH upgrade path (reuse `provision/ssh.ts` `sshRunScript` + the presigned
      bundle) so `node upgrade-agent <external>` reinstalls the binary and restarts the unit.
- [x] **5b:** require/accept the same `--ssh-key`/`--ssh-port` as `node init`; clear error +
      `manualUpgradeHint` fallback when SSH details are missing.
- [ ] **5c:** test the pure upgrade-script rendering; live-verify a binary bump on a throwaway box.
      Pure tests are in place; the live throwaway-box verification remains.
- **Done when:** `node upgrade-agent <external> --ssh-key …` rolls a new agent without manual steps.

### 6. 🟧 `node monitor` fallback for non-SSM nodes

**Problem:** `node monitor --watch` is SSM-only and requires `entry.instanceId`
(`packages/cli/src/commands/node/monitor.ts:274-280`), so it fails on BYOS — even though the
live host CPU/mem sample is already in `status.json` (the agent publishes `host`).

- [x] **6a:** when a node is external (no `instanceId`), drive `node monitor` from the
      `status.json` `host` sample instead of SSM sampling.
- [x] **6b:** label the source ("from heartbeat" vs "live over SSM") so the operator knows the
      cadence.
- **Done when:** `node monitor byos-node` shows host stats without SSM.

---

## Phase 3 — Security & hardening

> Goal: long-lived BYOS credentials are rotatable, and the rough enrollment edges are smoothed.

### 7. 🟧 Credential rotation / lifecycle

**Problem:** the per-node IAM user's access key is long-lived, never rotated, with no
re-issue-on-leak path. Long-lived static keys on a box are the main BYOS security liability.

- [x] **7a:** `node rotate-creds <external>` — mint a new access key, push it to the box's
      `/etc/launch-pad/agent.env` over SSH, restart the agent, then delete the old key
      (reuse `ensureExternalNodeIam` key-create + `deleteAccessKey`).
- [x] **7b:** harden the partial-failure window (a post-bootstrap/pre-register `node init`
      failure can still leave a stray key; the IAM 2-key/user limit can then bite on retry).
- [x] **7c:** doc the rotation cadence + revoke-on-compromise runbook.
- **Done when:** an operator can rotate or revoke a BYOS node's credentials without re-enrolling.

### 8. 🟧 Enrollment robustness

- [x] **8a:** SSH preflight — detect non-passwordless sudo / wrong user up front and fail with
      a clear message instead of a generic non-zero SSH exit (`provision/ssh.ts` + `node init`).
- [x] **8b:** smoother failed-enroll recovery — a heartbeat-timeout currently requires
      `node destroy` → re-init even though the box is already bootstrapped; allow a resume/retry.
- [x] **8c:** registry repair for externally-deleted boxes — `node reconcile` (or a prune)
      should flag/clear a long-dead external node entry (ties into 2c).

---

## Phase 4 — Full self-host (original spec Phase 2/3)

> Goal: the homelab / full-self-host persona — no EC2 at all.

### 9. 🟦 External edge nodes (`node init --role edge`)

Local support is implemented; live full-external-cluster validation remains.

- [x] **9a:** Caddy bootstrap in `renderExternalBootstrap` (edge role) — install Caddy, no Docker.
- [x] **9b:** edge specifics — public 80/443, stable `--public-ip` handling, `ingress.edge`
      wiring so app nodes route through an external edge.
- [x] **9c:** DNS panel output points at the user-managed edge IP; `dns verify` works for it.
- [ ] **9d:** doc + live-verify a fully external cluster (external edge + external app).

### 10. 🟦 Phase-3 polish

- [x] **10a:** `--advertise-ip` auto-detect over SSH with a confirm prompt (drop the required flag).
- [x] **10b:** Ubuntu 22.04+ / AL2023 bootstrap matrix in CI (the renderer claims both; only
      AL2023/dnf is live-verified today).
- [x] **10c:** SSM break-glass alternative for BYOS (document that SSM Run Command is
      unavailable; provide the SSH equivalents).

---

## Suggested sequencing

1. **Phase 1** first — it makes the already-shipped Phase-1 feature trustworthy in production
   (observable, not silently wedged, honest cost). Items 1a, 2a, 3a are each small and high-leverage.
2. **Phase 2** unblocks the primary persona (web apps on cheap hardware) and makes nodes
   maintainable.
3. **Phase 3** is the security follow-through.
4. **Phase 4** is the big optional expansion (full self-host) — a feature, not a fix.
