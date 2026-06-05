# Feature Plan — Node / EC2 drift reconciliation

> Status: **implemented** (code-complete; not yet live-verified on real EC2).
> Companion to `docs/overview.md` and `docs/clusters-plan.md`. The CLI now reconciles
> EC2 reality against the S3 node registry on `deploy` and via `node reconcile`, and
> surfaces drift on `node show` / `node list`.
>
> Shipped: `Ec2Observation` + `describeInstancesById` (`aws/ec2.ts`), pure
> `planNodeDrift` + tests (`deploy/drift-plan.ts`), imperative `applyNodeDrift`
> (`deploy/drift-apply.ts`), `replaceInstance` recreate path (`provision/provision-node.ts`),
> EC2-aware preflight + `--no-repair`/`--no-recreate` on `deploy`, and the
> `node reconcile [name]` command.

## Motivation

Launch Pad assumes nodes are operated through the CLI:

- `launch-pad node pause` stops EC2 **and** sets registry `state: "stopped"`.
- `launch-pad node resume` starts EC2 **and** sets registry `state: "ready"`.
- `launch-pad node destroy` terminates EC2 **and** deletes registry keys.

If an operator stops or terminates an instance in the **AWS console** instead:

| What breaks | Symptom |
|-------------|---------|
| Registry still says `ready` with a live `instanceId` | `deploy` publishes `desired.json` but nothing runs |
| Console stop, registry unchanged | Agent heartbeats go **stale** (~60s); `status` looks hung |
| Console terminate, registry unchanged | `node resume` fails; no replacement instance is created |
| Deploy never queries EC2 | It resumes registry-`stopped` nodes but trusts registry `state` blindly, so console-side stop/terminate is invisible |

> Today `deploy` already calls `buildProvisionPlan` and resumes any node whose
> **registry** state is `stopped` (`deploy.ts:373,387,450-459`). What it never does is
> check **EC2 reality** — so a node the console stopped (registry still `ready`) or
> terminated is published to anyway. This plan adds the EC2 read + reconcile; it does
> **not** "wire up resume" (that already works).

The product should treat EC2 as **ground truth for compute** and the S3 registry as
**ground truth for intent** (node identity, capacity, role, Elastic IP allocation).
Reconciliation closes the gap on CLI entry points — especially `deploy` — without
adding a control-plane server.

### Out of scope (already handled elsewhere)

- **Container drift** on a running instance — the agent's `planReconcile` loop
  (start stopped replicas, scale, rollout, remove orphans). No change.
- **Edge routing drift** across cluster nodes — `edge.ts` on edge-role agents.
  Unaffected except when the edge instance itself is stopped/terminated.
- **Agent process crash** with EC2 still running — heartbeat staleness is a separate
  signal (reboot instance, SSH, or reinstall agent); not EC2 registry drift.

---

## Locked decisions

1. **Pull-based, not a daemon** — drift is detected when the user runs CLI commands
   (`deploy`, `node show`, `node list`, `node reconcile`). No background poller in
   the CLI or a new AWS Lambda.
2. **Reconcile before publish on deploy** — `deploy` must not write `desired.json` to
   a node whose EC2 is stopped or missing unless repair succeeds or the user opts out.
3. **Same node identity on repair** — a terminated instance is replaced under the
   **same** `nodeId` (same S3 prefix, same Elastic IP allocation when one exists).
   Do not silently mint a new node name.
4. **Preserve durable AWS assets when recreating** — reuse `eipAllocationId`,
   `securityGroupId`, and `iamInstanceProfile` from registry where still valid;
   only replace the EC2 instance + refresh network fields.
5. **Explicit recreate** — replacing a terminated instance is a **repair** action,
   not silent. Default: prompt (or require `--yes`); `--repair` / `--no-repair`
   flags on `deploy` and `node reconcile`.
6. **Registry state is updated to match EC2** — after detection, S3 `node.json`
   `state` and IPs must reflect reality before the command continues.

---

## Drift taxonomy

Map EC2 `DescribeInstances` (or "not found") to a drift class. Registry `state` is
the left column; EC2 observation is the top row.

> **Assumption — registry `state` is intent, not liveness.** The agent does not flip
> `node.json` from `provisioning` → `ready` (heartbeat is the real liveness signal), so
> a never-paused live node sits at `provisioning` indefinitely. Drift logic therefore
> treats `provisioning` and `ready` **identically** as "intended running." Fixing the
> flip-to-`ready` gap is a separate task, out of scope here.

| Registry `state` | EC2 `running` | EC2 `stopped` | EC2 `stopping` / `pending` | EC2 `terminated` / not found |
|------------------|---------------|---------------|----------------------------|------------------------------|
| `ready` | OK (no drift) | **drift: stopped** | wait or treat as transitional | **drift: gone** |
| `stopped` | **drift: running** (console start) | OK | transitional | **drift: gone** |
| `provisioning` | OK | **drift: stopped** | wait | **drift: gone** |
| `terminating` / `terminated` | unexpected | — | — | OK / cleanup |

**Transitional states** (`pending`, `stopping`, `shutting-down`): either short-wait
with timeout (reuse existing `waitUntil*` helpers) or surface "node is not stable yet"
without mutating registry.

### Repair actions per drift class

| Class | Detection | Repair action | Registry update |
|-------|-----------|---------------|-----------------|
| `ready`/`provisioning` + EC2 stopped | `State.Name === "stopped"` | `resume` (StartInstances + refresh IP) | `state: "ready"`, update `publicIp` / `availabilityZone` |
| `stopped` + EC2 running | `State.Name === "running"` | sync only (no start) | `state: "ready"`, refresh IPs |
| any + instance missing / terminated | empty reservation or `terminated` | `recreate` (new RunInstances, same SG/EIP/role) | new `instanceId`, `state: "ready"`, refresh IPs |
| `ready`/`provisioning` + EC2 running, agent stale | heartbeat only | **warn**, not EC2 repair | optional message in deploy output |

---

## Target behavior

### `deploy` (primary UX)

Before capacity checks and before writing `desired.json`:

1. Collect every referenced `nodeId` (app + edge), load registry entries.
2. For each entry with `instanceId`, call `DescribeInstances` (batch by id).
3. Run `reconcileNodeDrift(entry, ec2Observation, options)` → list of repairs.
4. Apply repairs in order: `sync` → `resume` → `recreate` (at most one structural
   repair per node per deploy).
5. If repair fails or `--no-repair` and drift exists → `CliError` with hint
   (`node reconcile <name>` or `node resume <name>`).
6. Continue with today's deploy (capacity, build, publish, watch).

`buildProvisionPlan` (`packages/cli/src/deploy/provision-plan.ts`) becomes one
input to this pipeline: registry-only `stopped` → `{ kind: "resume" }` merges with
EC2-confirmed stopped; registry `ready` + EC2 stopped overrides to resume.

### `node reconcile <name>` (explicit repair)

New subcommand for operators who fixed things in the console or hit a failed deploy:

- Describes EC2, prints drift summary, applies repairs with `--yes`.
- Flags: `--dry-run`, `--yes`, `--no-recreate` (fail if instance is gone instead of
  replacing it).

### `node show` / `node list` (observability)

- **`node show`**: after loading registry, describe EC2; display **both** registry
  `state` and **live** EC2 state; flag `DRIFT` when they disagree.
- **`node list`**: optional `--refresh` (or default lightweight describe) to show
  `ready (stopped in EC2)` style hints without mutating state.

### Pause / resume / destroy (unchanged semantics)

Console changes do not replace these commands. After drift repair, `node pause` and
`node resume` remain the supported cost-saving path and must continue to update
registry and EC2 together.

---

## API shape (CLI-internal)

### EC2 observation

```ts
type Ec2Observation =
  | { kind: "running"; publicIp: string | null; privateIp: string | null; az: string | null }
  | { kind: "stopped" }
  | { kind: "transitional"; state: string }
  | { kind: "missing" }; // terminated, never existed, or wrong account/region
```

Add `describeInstancesById(ec2, ids[]): Map<string, Ec2Observation>` in
`packages/cli/src/aws/ec2.ts` (batch `DescribeInstances`, normalize states).

> `describeInstanceIp` (`ec2.ts:211`) already issues a single-id `DescribeInstances`
> returning only the public IP. `describeInstancesById` should **generalize and
> supersede it** (batch ids → `Map<id, Ec2Observation>`); migrate the one `node show`
> caller (`commands/node/index.ts:324`) onto the richer observation.

### Drift plan (pure, testable)

```ts
type DriftAction =
  | { kind: "noop" }
  | { kind: "syncRegistry"; nextState: "ready" | "stopped"; publicIp?: string | null; ... }
  | { kind: "resume"; entry: NodeRegistryEntry }
  | { kind: "recreate"; entry: NodeRegistryEntry; preserve: { eip?, sg?, profile? } };

function planNodeDrift(
  entry: NodeRegistryEntry,
  ec2: Ec2Observation,
  opts: { allowRecreate: boolean },
): DriftAction[];
```

Extend `NodeAction` in `provision-plan.ts` (or a sibling `drift-plan.ts`):

```ts
| { kind: "repair"; nodeId: string; actions: DriftAction[] }
```

`buildProvisionPlan` stays registry-first for **missing nodes** (`create`) and
delegates existing entries to `planNodeDrift` when an EC2 loader is injected.

### Apply (imperative)

```ts
async function applyNodeDrift(aws: AwsEnv, actions: DriftAction[]): Promise<NodeRegistryEntry>;
```

- `syncRegistry` → `putJson(node.json)` only.
- `resume` → `resumeNode` (existing).
- `recreate` → extract from `provisionNode` a **`replaceInstance`** path:
  - `RunInstances` with same SG, subnet/AZ preference, IAM profile, user-data.
  - Re-associate existing Elastic IP allocation.
  - Update registry `instanceId`, IPs, `state: "ready"`.
  - Do **not** delete unrelated S3 keys (`desired.json` preserved).

---

## Changes by package

### `packages/shared`

| File | Change |
|------|--------|
| `registry.ts` | Optional: `lastReconciledAt`, `ec2State` snapshot on entry for debugging (not required for v1). |
| `registry.ts` | Document that `terminated` registry state means "CLI destroy completed", not "EC2 might be gone". |

No change to `desired.json` / `status.json` wire format.

### `packages/cli`

| File | Change |
|------|--------|
| `aws/ec2.ts` | `describeInstancesById`, helpers for `Ec2Observation`. |
| `deploy/drift-plan.ts` (NEW) | `planNodeDrift` + tests. |
| `deploy/provision-plan.ts` | Integrate EC2-aware planning; export unified `planNodesForDeploy`. |
| `provision/provision-node.ts` | `replaceInstance(aws, entry)` for recreate path. |
| `commands/deploy.ts` | Pre-flight drift reconcile on all referenced nodes. |
| `commands/node/index.ts` | `node reconcile`; drift display on `show` / `list`. |
| `deploy/watch.ts` | No change (still agent status). |

### `packages/agent`

No change. Agent continues to reconcile containers only when the instance is running.

---

## UX and flags

| Flag | Commands | Default | Meaning |
|------|----------|---------|---------|
| `--repair` | `deploy`, `node reconcile` | `true` | Apply drift fixes automatically |
| `--no-repair` | `deploy`, `node reconcile` | — | Fail with clear drift error |
| `--no-recreate` | `deploy`, `node reconcile` | — | Allow resume/sync only; fail if instance is gone |
| `--yes` | `node reconcile`, `deploy` when recreating | — | Skip recreate confirmation |
| `--dry-run` | `node reconcile` | — | Print planned repairs only |

**Confirmation copy** for recreate: warn that a new instance will boot (brief downtime,
agent will re-install via user-data). Elastic IP is preserved when configured.

---

## Phased rollout

### Phase 1 — detect + sync + resume on deploy

1. `describeInstancesById` + `planNodeDrift` (pure tests).
2. Feed `Ec2Observation` into deploy's existing node preflight so the plan reflects
   EC2, not just registry: registry-`ready`/`provisioning` + EC2 `stopped` now also
   routes to `resumeNode` (today only registry-`stopped` does); registry-`stopped` +
   EC2 `running` syncs registry to `ready` without a start.
3. `node show` / `list` display live EC2 state + drift badge (read-only).

**Checkpoint:** stop a node in the AWS console, run `deploy --repair` → instance
starts, registry `ready`, agent converges.

### Phase 2 — recreate terminated instances

1. `replaceInstance` in `provision-node.ts`.
2. `deploy --repair` and `node reconcile` handle `missing` drift.
3. Confirmation prompt unless `--yes`.

**Checkpoint:** terminate a node in the console, run
`node reconcile <name> --yes` → new instance, same node id and EIP, deploy succeeds.

### Phase 3 — polish

1. `node reconcile` without deploy (operator tooling).
2. Batch describe on `node list --refresh`.
3. JSON output fields: `registryState`, `ec2State`, `drift`, `repaired`.

---

## Test strategy

- **Unit** — `planNodeDrift`: matrix of registry × EC2 observation → actions; no AWS.
- **Unit** — extend `provision-plan.test.ts` with EC2 loader mock (stopped + ready
  mismatch).
- **Integration** (optional, tagged) — LocalStack or recorded AWS fixtures for
  `describeInstancesById` parsing.
- **Manual** — script in plan checkpoint: console stop → deploy; console start without
  resume → deploy sync; console terminate → reconcile.

---

## Backward compatibility

- Default `deploy --repair` improves behavior for existing projects; `--no-repair`
  restores today's "publish anyway" semantics for advanced users.
- No S3 key migration. `node.json` shape unchanged unless optional metadata fields
  are added later.
- Nodes without `instanceId` (registry-only) skip EC2 describe; `create` path
  unchanged.

---

## Resolved decisions

1. **Recreate keeps `desired.json`** — on recreate, leave `desired.json` in place (the
   agent reconciles on boot); clear/overwrite stale `status.json` (or let the agent
   overwrite on first tick).
2. **Repair edge before app** — when a deploy repairs multiple nodes, repair edge-role
   nodes first so ingress exists before app replicas health-check.
3. **Wrong-account `missing` → fail fast** — if `DescribeInstances` returns nothing
   because credentials point at another account/region, fail with an auth hint; never
   recreate.
4. **IAM / SG deleted → out of scope (v1)** — if the security group or instance profile
   was deleted in the console, fail with "run `node destroy` then `node create`"; full
   recreation of supporting resources is later scope.
5. **One batch `DescribeInstances` per deploy** — collect all referenced instance ids
   and issue a single call (AWS allows many ids per request).

---

## Related docs

- `docs/overview.md` — declarative S3 contract, agent reconcile scope.
- `docs/clusters-plan.md` — cluster-scoped node prefixes; drift logic is per-entry
  and cluster-aware via existing `nodeRegistryKey(clusterId, nodeId)`.
