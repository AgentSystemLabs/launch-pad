# Launch Pad — production gaps (indie-hacker UX)

Audit of what is **not supported yet** (or only partially supported) for the north-star flow:

> set up AWS → `lpd deploy` in a repo → auto node + HTTPS → rolling updates → easy scaling & placement

**Legend:** ❌ not built · ⚠️ partial / manual · ✅ exists today

---

## Your stated goals — status

| Goal | Status | Notes |
| ---- | ------ | ----- |
| Set up an AWS account and deploy | ✅ | `launch-pad setup` (no subcommand) is a guided first-run wizard: pick region → create the state bucket → save `~/.launch-pad/config.toml` (named clusters). `launch-pad doctor` preflights the environment (Docker, AWS creds/region, S3, ECR, default VPC, golden AMI) before any spend; `setup iam-policy` generates a least-privilege operator policy and `setup github-oidc` a keyless-CI (GitHub OIDC) trust policy + workflow. |
| `lpd deploy` creates default-cluster node if missing | ✅ | Auto-provision + auto-size referenced nodes (`node`, `nodes`, or `edge`). |
| Rolling deploy on update | ✅ | Health-gated rolling updates, immutable ECR tags, convergence watch. |
| Automatic HTTPS + domain help | ⚠️ | Caddy + Let's Encrypt on the node. Deploy prints a **DNS panel** (per-domain A-record target = the fronting node's Elastic IP); `launch-pad dns setup` **writes** the DNS-only A record for Route53-hosted domains; `launch-pad dns verify` checks the record + flags a Cloudflare-proxied (orange-cloud) record that breaks HTTP-01. Non-Route53 (Cloudflare/registrar) record creation is still manual. |
| Cloudflare one-click A record | ⚠️ | **Route53** write integration ships (`dns setup`). Cloudflare/other-registrar write integration is still missing — `dns verify` detects an orange-cloud record but you create/flip it manually. |
| Autoscale nodes/services via simple config / CLI | ⚠️ | `launch-pad scale replicas\|cpu\|memory` + `launch-pad config set` ship now; the config lock allows `cpu`/`memory`/`replicas`/`env`/`secrets` post-deploy. Still no ASG / reactive node autoscaling, and `node resize` still stops the instance (downtime). |
| Redistribute services when nodes are added | ✅ | `launch-pad rebalance` replans the footprint's cluster-placed services across the **current** app pool and republishes (reusing published images, no rebuild) — spread onto a new app node, or consolidate. Pinned `node`/`nodes` services never move (config-locked). Config-lock-safe; idempotent. |
| Delete a node and redistribute workloads | ✅ | `node evacuate <node>` (= `rebalance --drain <node>`) moves the footprint's cluster-placed services off a node so `node destroy`/`pause` (which refuse to orphan scheduled services) accept it. Refuses to evacuate a pinned service or drain the last app node. |

---

## P0 — blocks the “simple laptop deploy” promise

### First-run & AWS onboarding

- [x] **`launch-pad doctor` / preflight** — read-only checks (provisions nothing) for Docker+buildx, AWS creds/region/identity, S3 state bucket, ECR access, default VPC, and golden-AMI availability; pass/warn/fail/skip per check, non-zero exit on any fail (CI-gateable). Verified against real AWS (pass + warn paths). _Follow-up: per-permission IAM probes (EIP/IAM/SSM dry-runs) and quota checks._
- [x] **`launch-pad setup` (interactive bootstrap)** — bare `launch-pad setup` (no subcommand) is now a guided first-run wizard: resolve the AWS account (STS) → pick a region (interactive prompt, or `--region`) → create/confirm the account+region **state bucket** (idempotent `ensureBucket`) → for a `--cluster <name>` also save the `~/.launch-pad/config.toml` target + write `cluster.json` (the implicit `default` cluster runs on ambient creds, so nothing is saved locally — its value is ensuring the bucket so the first deploy doesn't 403) → print next steps (`doctor` / `init` / `deploy`). Interactive on a TTY; fully scriptable with `--region`/`--cluster`/`--yes`. The two template subcommands (`iam-policy`, `github-oidc`) still dispatch under `setup`. Pure `buildSetupPlan` (`cli/src/setup/wizard.ts`) unit-tested; real-AWS regression (`pnpm e2e:setup`: default-cluster path ensures the bucket with no local target; named-cluster path saves the target + cluster.json + resolves via `cluster show`; teardown keeps the shared state bucket).
- [x] **Operator IAM policy template** — `launch-pad setup iam-policy` prints a least-privilege policy for the operator/CI principal: exactly the AWS actions deploy/provision/manage use, scoped to the launch-pad state bucket, ECR repos, `launch-pad-node-*` IAM roles, `/launch-pad/*` secrets, CloudWatch Logs, and a single region (`aws:RequestedRegion` condition). `--account`/`--region` run offline; otherwise resolved from STS. Pure generator (`cli/src/setup/operator-policy.ts`, mirrors the per-node policies in `aws/iam.ts`) — unit-tested (scoping + no wildcard actions + size limit) and **verified end-to-end against real AWS** (`pnpm e2e:operator-iam`: mint a temp IAM user with ONLY this policy → full provision → deploy → undeploy → destroy under it → assert it can't act outside its scope/region → tear down). IAM Access Analyzer `validate-policy` returns zero findings.
- [x] **CI OIDC template** — `launch-pad setup github-oidc --repo <owner/name>` prints a GitHub Actions OIDC role trust policy (federates GitHub's provider; `aud` pinned to `sts.amazonaws.com`, `sub` pinned to repo/branch so no other repo can assume it) + a ready-to-commit deploy workflow (keyless — no long-lived keys). `--branch` pins one ref (default `main`); `--all-branches` opens to any ref (warned: includes PRs/tags). Pure generator (`cli/src/setup/github-oidc.ts`) — unit-tested.

### DNS & HTTPS (biggest indie-hacker friction after first deploy)

- [x] **Post-deploy DNS panel** — every `deploy` now prints a per-domain A-record target (the fronting node's Elastic IP, edge vs co-located) + a "DNS-only A record, then `dns verify`" hint. (Live cert-status polling is still a future add.)
- [x] **`launch-pad dns verify <domain>`** — resolves A/AAAA/CNAME, looks up the expected EIP from the cluster registry (or `--expect <ip>`), and reports `ok` / `wrong-ip` / `cloudflare-proxied` / `no-records` / `no-expected-ip` with a non-zero exit on real problems. Unit-tested classifier + live-smoke-tested against real DNS.
- [ ] **Cloudflare one-click A record** — `launch-pad dns setup` (or deploy flag): OAuth/API token → create/update **DNS-only** A record to edge/both EIP; link out to Cloudflare dashboard for token setup. _(deferred — needs an external Cloudflare API token; `dns verify` already detects the orange-cloud footgun)_
- [x] **Route53 helper** — `launch-pad dns setup` creates/updates **DNS-only** A records in Route53 for every web service in the project (or one `--service`), pointing each domain at the Elastic IP of the node that fronts it (edge or co-located). Idempotent (a correct record is reported `already set`, never re-written); shows a plan + confirms before writing (`--yes` for CI); `--wait` blocks until INSYNC; domains not in a Route53 zone are skipped (non-zero exit) so Cloudflare/registrar users fall back to a manual grey-cloud record. Pure planner (`cli/src/dns/plan.ts` `planDnsTargets` + `selectHostedZone` — env projection + the co-located-vs-edge fronting decision) unit-tested; thin client `cli/src/aws/route53.ts`; operator IAM policy extended with scoped `route53:*` (global service, no region condition). Real-AWS regression (`pnpm e2e:dns`: provision a both node → `dns setup` → `dns verify` ok → idempotent re-run → record removed on teardown).
- [ ] **Cloudflare-proxied / DNS-01 TLS** — support orange-cloud domains (Caddy DNS challenge or Cloudflare origin cert path). Today proxied DNS is a detected footgun (`dns verify`), not yet a product path.

### Config lock vs. operational changes (critical mismatch) — ✅ RESOLVED

After the first successful deploy, the project's **identity/shape** is frozen, but the
**operational** fields are now mutable: `cpu`, `memory`, `replicas`, `env`, and `secrets`
(key names). Deploy still aborts before build on an identity change (placement, domain, port,
build inputs, health check, rollout, add/remove/rename a service) — there is no bypass flag
for those.

Still locked (identity — by design):

- `node` / `nodes` / `edge` / `cluster` placement, `schedule` / `topology`
- add/remove/rename services
- `domain`, `port`, `healthCheck`, `rollout`, `dockerfile`, `domainPattern`, …

Shipped:

- [x] **`launch-pad scale replicas <service> <n>`** — edits TOML + runs a single-service deploy; replica count is now a safe post-deploy mutation.
- [x] **`launch-pad scale cpu|memory …`** — wraps the two vertical-scale fields, validated against node capacity (the deploy admission check).
- [x] **Allowlisted post-deploy TOML edits** — `replicas`, `env`, `secrets` keys are mutable; identity fields stay locked (no `--force` escape hatch — re-create the footprint to change identity).
- [x] **`launch-pad config set|unset <service> KEY[=VALUE]`** — ergonomic CLI that edits the `env` table instead of hand-editing a locked file (secrets → `launch-pad secret`).

> Verified by unit tests (`config-lock.test.ts`, `toml-edit.test.ts`, `deploy.test.ts`) and a
> dedicated real-AWS regression (`pnpm e2e:scale`: provision → deploy worker → scale 1→3 →
> `config set` env → scale 3→1, with teardown). The full-lifecycle `pnpm e2e` also exercises
> `scale`/`config` against a web service behind an edge.
>
> Not yet done (separate items below): an override file for env-specific (`--env`) scaling, and
> auto-adding a node when a scale-up doesn't fit (see **Capacity & node autoscaling**).

### Service & node lifecycle

- [x] **`launch-pad undeploy` / `service remove`** — removes a project footprint (or one `--service`) from each node's `desired.json` (the agent drains the containers), **trims the config baseline** so a follow-up deploy of the edited `launch-pad.toml` passes the lock (whole-footprint undeploy clears the baseline → fresh first deploy), optional `--purge-secrets` (SSM), and waits for drain. Ownership-scoped (never touches another project) with CAS-guarded baseline writes. Unit-tested (`shared/undeploy.test.ts`, `cli/commands/undeploy.test.ts`) + real-AWS regression (`pnpm e2e:undeploy`). ECR images are intentionally kept (immutable, preserve rollback).
- [x] **`launch-pad node evacuate <node>`** — moves the current project's **cluster-placed** services off a node (= `rebalance --drain`), reusing published images, so `node destroy`/`pause`/`resize` (which refuse to orphan scheduled services) accept it. Refuses to evacuate a **pinned** service (config-locked placement) or drain the last app node. Run per project. Real-AWS verified (`pnpm e2e:rebalance`: evacuate node-b → replicas consolidate → `node destroy` succeeds). _Follow-up: cross-project auto-evacuate-all + edge-routing drain for web services._
- [x] **`launch-pad rebalance`** — replans the footprint's cluster-placed services across the current app pool via the same scheduler `deploy` uses, reusing each service's published image (no rebuild), republishing per-node desired.json (gainers before reducers) + cleaning vacated nodes. `--dry-run` / `--drain <node>` / `--env`. Config-lock-safe (toml must match baseline; only placement changes); idempotent ("already balanced" → no write). Pure diff planner (`deploy/rebalance-plan.ts` `diffPlacement`) + extracted `buildCandidateNodes` (shared with deploy) unit-tested; real-AWS regression (`pnpm e2e:rebalance`: deploy even a:2/b:1 → evacuate → spread back). _Follow-up (concurrency review): rebalance is eventually-consistent + not concurrency-fenced against a simultaneous deploy/scale of the same footprint (a re-run reconciles); a footprint version-fence + per-service surge-then-shed ordering + edge-domain shrink are the hardening follow-ups._
- [x] **Destroy should refuse or auto-evacuate** — `node destroy` now **refuses** when a node still hosts scheduled services (lists the at-risk `project/service`s), requiring `--force` to orphan them. Auto-evacuate-inline is the follow-up (depends on `node evacuate` above). Unit-tested (`nodesThatWouldOrphan`) + verified in `pnpm e2e:scale`.

### Capacity & node autoscaling

- [x] **Auto-add app node on capacity pressure** — when cluster-auto-placed services don't fit the current pool, deploy now **adds `app-<n>` node(s)** (sized like the cluster's existing nodes) and re-plans onto the larger pool, instead of erroring "reduce cpu/memory/replicas". Works for both `even` (round-robin overflow detected post-plan) and `capacity` (planner throws a catchable `CapacityPlacementError`) scheduling; bounded by the replica count; spend-gated by the same provision confirmation (`--yes` in CI); `--no-create` restores the hard error. Pure `planClusterPlacementAutoAdd` + `templateCandidateNode` + `nextAppNodeId` + `CapacityPlacementError` in `cli/src/deploy/placement.ts` (reuses the existing planner/provision/sizing — added nodes are provisioned for real, auto-sized to their placement; a non-capacity planner error like "split needs an edge" is rethrown, never triggering an add). Unit-tested (`placement.test.ts` +10) + real-AWS regression (`pnpm e2e:auto-add`: bootstrap 1 node at replicas=1 → `scale replicas 3` auto-adds `app-2` → 3 replicas spread 2/1).
- [x] **Empty-cluster bootstrap** — the first deploy of cluster-auto-placed services to a cluster with **no nodes** now auto-provisions a single co-located node (`app-1`) and places onto it (parity with the default cluster's single-node auto-provision), instead of erroring "no app nodes". Spend-gated (confirm / `--yes` / `--no-create`); the instance is auto-sized to fit and any edge a `split` service needs is provisioned too. Implemented as a synthetic candidate node (`bootstrapCandidateNode` in `cli/src/deploy/placement.ts`) injected into the planner pool when empty, so all topology/edge/sizing logic reuses the existing planner + provision flow. Unit-tested (`placement.test.ts` — both-role pool eligibility, large-demand placement, co-located/split routing, split-without-edge still rejected) + real-AWS regression (`pnpm e2e:empty-cluster`: empty cluster → `--no-create` refused → deploy bootstraps `app-1` → worker runs → idempotent re-deploy).
- [ ] **Reactive autoscaling policy** — declarative min/max app nodes and/or max replicas based on CPU/memory headroom or schedule (even simple “maintain N app nodes” would help).
- [ ] **Non-disruptive vertical scale** — `node resize` today stops the instance; explore rolling evacuate → replace → rebalance.

---

## P1 — expected for serious production use

### CI/CD

- [x] **Official GitHub Action** — `launch-pad setup github-oidc --repo <owner/name>` emits a keyless
  (OIDC) `.github/workflows/deploy.yml`: checkout → assume role via OIDC → Docker Buildx →
  `npx @agentsystemlabs/launch-pad deploy --yes`. Now **concurrency-guarded** (one deploy per ref,
  cancel superseded — matches deploy's CAS write protection) with a manual `workflow_dispatch` trigger,
  and documented in [cli.md](docs/cli.md#setup-github-oidc) with **caching guidance** (pin the CLI
  version, optional `cache: npm` when a lockfile exists, Dockerfile layer ordering, self-hosted runner
  for heavy builds). Pure `buildDeployWorkflow` unit-tested (+2); the deploy-under-OIDC runtime is
  already real-AWS-verified by `pnpm e2e:operator-iam` (full provision→deploy→destroy under a scoped role).
- [ ] **Remote build** — deploy without local Docker (CodeBuild / ECR build pipeline / pre-built image deploy) for slim CI runners.
- [x] **`deploy --image <uri>`** — `deploy --service <name> --image <uri>` skips the build and redeploys an existing immutable ECR tag (rollback / promote). Validated to the service's own repo + an existing tag; re-rolls in place health-gated; idempotent on a repeat. Pure parser (`shared/src/ecr.ts` `parseEcrImageUri`) + `loadOverrideImage` unit-tested; real-AWS regression (`pnpm e2e:deploy-image`: v1 → v2 → roll back to v1 without building). Next: a `launch-pad rollback` wrapper that auto-picks the previous tag (ECR push order / deploy history).

### Rollback & release safety

- [x] **`launch-pad rollback`** — `rollback --service <name> [--to <tag>]` redeploys a service's previous immutable ECR build (or a specific tag) without rebuilding, by delegating to `deploy --image`. Auto-pick is "most-recent build pushed before the current one" (`findPreviousImageTag` over `listRepoImageTags`); refuses to silently roll forward (asks for `--to` when nothing older). Pure picker + `resolveRollback` unit-tested; real-AWS regression (`pnpm e2e:rollback`). _Follow-up: whole-footprint rollback once deploy history (`events/`) lands — today rollback is per-`--service`._
- [x] **Deploy history** — every `deploy` appends an append-only event to `…/projects/<footprint>/events/` in S3 (who=caller ARN / when / image per service / kind / converged); `launch-pad history [--service] [--env] [--limit]` reads them newest-first. Advisory (never read by the agent), best-effort (a failed write can't fail a deploy), no secret values. Schema in `shared/src/events.ts`; recorded by `deploy`'s `recordDeployEvent`. Unit-tested (`events.test.ts`, `history.test.ts`, `s3-keys.test.ts`) + real-AWS regression (`pnpm e2e:history`).
- [ ] **Canary / blue-green** — beyond single-service rolling surge (optional advanced rollout strategy).

### Observability & alerting

- [x] **Alerting** — `launch-pad alerts check` is a scheduled-probe health check (cron / GitHub Action)
  that scans the cluster and flags **real faults on nodes that should be running**: a live node whose
  agent stopped heartbeating (or, past a ~10-min boot grace, never reported) and a service in `error`
  / fully down (0 running replicas). Deliberately quiet on non-faults (a paused node's agent is off on
  purpose; a still-booting node gets its grace; a partial mid-rollout replica dip doesn't alert).
  Exits **non-zero** on any alert (CI-gateable) and POSTs a Slack/Discord-compatible payload to
  `--webhook` (or `LAUNCHPAD_ALERT_WEBHOOK`). Pure `evaluateAlerts` + `buildAlertPayload`
  (`cli/src/alerts/`) unit-tested (15) + real-AWS regression (`pnpm e2e:alerts`: deploy a worker →
  clean check → **terminate the instance out-of-band** so the registry still reads "up" while the
  agent goes silent → alert fires + webhook delivered + non-zero exit). _Follow-up: continuous
  (not on-demand) monitoring, cert-renewal-fail + node-drift signals, and a deploy-convergence-fail
  hook (deploy already exits non-zero on non-convergence, which is CI-gateable today)._
- [ ] **External uptime check** — synthetic HTTPS probe independent of the node (or integrated Route53 health check).
- [x] **Dashboard production story** — documented the gap in [`docs/dashboard.md`](docs/dashboard.md#production-story-the-gap):
  the dashboard is a local operator convenience (localhost-only, no auth, drives the CLI with your
  local AWS creds), **not** a hosted control plane — and a hosted one is deliberately out of scope
  (Launch Pad is declarative with no control-plane server). Documents the supported shared-operation
  paths instead: CI/CD (OIDC) as the shared control surface, scheduled `alerts check`/`cost --budget`
  gates with webhooks, or running the dashboard behind your own auth/SSH tunnel.

### Data & stateful apps

- [x] **Persistent volumes** — `[[service.volumes]]` (`name` + container `path`) declares a node-local
  docker named volume the agent mounts into the service's container(s); its data **survives a
  container replace** (rolling deploy / `deploy --restart` / reboot) so SQLite, uploads, and local
  caches don't reset on every deploy. A volume-bearing service must be **pinned to a single `node`**
  (cluster auto-placement / `nodes` would move or split the data) and volumes are **config-locked
  identity** (no add/remove/re-path after the first deploy). The volume name is per-service +
  index-independent (`launchpadvol_<project>_<service>_<name>`) so it's re-mounted across the
  index-renumbering rollout. Deploy **refuses** to publish a volume-bearing service onto a
  legacy rust-agent node (`assertVolumesSupported`) rather than silently drop the mount.
  Schema in `shared/src/config.ts` (`VolumeDeclSchema` + validation) + `desired.ts`
  (wire) + `config-lock.ts` (locked); mounts in `agent/src/docker.ts` (`buildRunArgs`/`volumeName`).
  Unit-tested (config +8, config-lock +3, agent docker +4, deploy +7) + real-AWS regression
  (`pnpm e2e:volumes`: deploy a `/data` worker → boot count 1 → `deploy --restart` replaces the
  container → boot count 2 (data persisted) → config lock refuses a volume-path change). EBS-volume
  attach (cross-node-failure durability) is a follow-up; named volumes give container-replace
  durability on the node's root EBS.
- [ ] **Managed data plane helpers** — optional RDS Postgres / ElastiCache provisioning or “attach existing” wizard (indie hackers still need a database story).
- [x] **Backup/restore** — `launch-pad backup` exports a cluster's authoritative S3 state (registry `cluster.json`/`node.json`, `desired.json`/`status.json`, config baselines, deploy events) to a local directory keyed by S3 key + a `manifest.json`; `launch-pad restore <dir>` re-uploads it (gated by a confirm / `--yes`). Read-only backup; state-only (no plaintext secrets — `desired.json` carries SSM refs, not values). Restore fails closed against a tampered backup dir: three pre-AWS guards (clean relative key / within the target cluster's keyspace / present in the manifest) + a per-file size cap, and symlinks are skipped. Default cluster sweeps the legacy `nodes/`+`projects/` roots; a named cluster sweeps `clusters/<id>/`. Pure planner (`cli/src/backup/plan.ts` — `backupPrefixesForCluster`/`isSafeBackupKey`/`keyUnderPrefixes`) unit-tested; security-reviewed (traversal guards confirmed sound; manifest-enforcement + size-cap hardening added). Real-AWS regression (`pnpm e2e:backup`: set up cluster + synthetic object → backup → delete from S3 → restore → assert byte-for-byte → cluster resolves again). ECR images are out of scope (immutable, rebuildable).

### Security & multi-tenant ops

- [ ] **Cross-account clusters** — `cluster create --role-arn` is saved locally but explicitly “Phase 2 / not activated”.
- [x] **IAM cleanup on single-node destroy** — `node destroy` now deletes the node's per-node IAM role + instance profile (via the same best-effort, idempotent `deleteNodeIam` `cluster destroy` uses), so it no longer leaves orphan roles/profiles. Only ever touches `launch-pad-node-<cluster>-<node>`-named resources (a legacy shared role is untouched). Unit-tested (`destroy.test.ts` — `teardownNode` sends the IAM teardown + is best-effort on failure) + real-AWS regression (`pnpm e2e:node-iam`: create node → assert role/profile exist → destroy → assert gone).
- [ ] **Edge hardening options** — rate limits, basic WAF (or Cloudflare integration), IP allowlists — none in product surface.

### Cost visibility

- [x] **Ongoing cost visibility** — `launch-pad cost [--cluster] [--budget <usd>]` rolls up the cluster's **running** nodes (registry-driven) into a monthly EC2 + agent-S3 estimate (per-node + total), reusing the provision-time pricing (`cost/estimate.ts`). Paused nodes are counted + flagged separately (no compute charge, but they still incur EBS + Elastic IP). Pure `summarizeClusterCost` + `budgetVerdict` unit-tested; real-AWS regression (`pnpm e2e:cost`). _(A live/hosted dashboard is still future — this is an on-demand CLI estimate.)_
- [x] **Budget hooks (CLI)** — `launch-pad cost --budget <usd>` exits **non-zero** + warns when the estimate exceeds the threshold, so it's gateable in CI / a scheduled check. _(Native AWS Budgets integration is still future.)_
- [x] **Idle recommendations** — `launch-pad cost` now flags idle nodes wasting money: a **paused**
  (stopped) node still paying for its EBS volume + Elastic IP, or an **empty** running node hosting
  zero services (or an edge routing zero domains) burning its full EC2 rate — the empty case
  dollar-estimates the wasted compute. `--idle-days <n>` tunes the age threshold (default 7);
  recommendations are advisory (only `--budget` changes the exit code) and ride the existing `cost`
  output (panel + `--json` `idle.recommendations`). Pure `recommendIdleNodes` (`cli/src/cost/idle.ts`
  — paused dated from the last heartbeat falling back to `createdAt`; empty requires `state="ready"`
  + idle past threshold; an edge with unknown routing is never flagged; provisioning/terminating
  skipped) unit-tested (`idle.test.ts` +12) + real-AWS regression (`pnpm e2e:idle`: provision a both
  node → not flagged while provisioning → `node pause` → flagged `paused` → high threshold gates it
  out → teardown).

---

## P2 — polish & ecosystem

### Developer experience

- [x] **`launch-pad init` improvements** — interactive `init` now **detects the project** to seed smarter
  defaults: reads the Dockerfile's `EXPOSE` port and `package.json` for a known web framework (Express,
  Next.js, Fastify, NestJS, Astro, Nuxt, SvelteKit, Remix, hapi, Hono, Koa), then defaults the
  "web service?" + port prompts accordingly (a Dockerfile `EXPOSE` wins over a framework default) and
  prints a `detected …` note. Pure `projectHints`/`detectExposePort`/`detectFramework`
  (`cli/src/init/detect.ts`) unit-tested (11); non-interactive/flag-driven behavior unchanged.
  _Follow-up: framework-specific health-check path scaffolding + a multi-service monorepo template._
- [ ] **Monorepo / multi-service deploy** — first-class “deploy changed services only” (git diff → `--service` list).
- [ ] **Preview environments** — `deploy --env pr-123` with automatic DNS pattern + TTL teardown (env flag exists; full PR lifecycle automation does not).
- [x] **Shell completions** — `launch-pad completions <bash|zsh|fish>` prints a completion script
  generated from the **live commander tree** (so it never drifts from the real commands), wired for
  both `launch-pad` and `lpd` bins. Completes top-level commands, their subcommands (`node create`,
  `cluster use`, …), and global flags. Pure `commandTree` + per-shell `generateCompletion`
  (`cli/src/completions/generate.ts`) unit-tested (5); each generated script validated for syntax
  (`bash -n`, `zsh -n`) + a functional bash check (prefix-filter + subcommand expansion).
- [x] **Global npm install story** — [`docs/getting-started.md`](docs/getting-started.md#installing-the-cli)
  now documents the install options (npx / `npm i -g` / pin a version for reproducible CI / dev
  dependency), the two bins (`launch-pad` + `lpd`), the upgrade path (`@latest`), and the
  CLI-bundles-the-agent ordering caveat (upgrade CLI → `node upgrade-agent` → deploy across a wire change).

### Platform & integrations

- [ ] **Multi-region** — single project spanning regions (or documented “one cluster = one region” with failover story).
- [ ] **Custom domains at scale** — wildcard certs, apex + www, multiple domains per service without hand-editing Caddy.
- [ ] **Worker scheduling** — cron / periodic jobs as a first-class service type (not just long-running workers).
- [ ] **Static assets / CDN** — S3+CloudFront or “static service” type for SPAs without a container.
- [ ] **Control-plane API** — remote deploy triggers, team RBAC, audit (overview lists as future; still out of scope).

### Docs & examples gaps

- [x] **Single “indie hacker happy path” doc** — [`docs/happy-path.md`](docs/happy-path.md): AWS → `doctor` → first deploy → DNS-only A record + `dns verify` (Cloudflare orange-cloud footgun) → rolling updates → scale/config/secrets → rollback/history → grow to a named cluster (placement) → `undeploy` + `node destroy` (refuses to orphan; tears down IAM too) + `cluster destroy`. Linked from README + getting-started.
- [x] **Config lock guide** — `docs/configuration.md#config-lock` now has the mutable-vs-locked table and the exact command for each mutable field (`scale` / `config` / `secret`).
- [x] **Stale overview cleanup** — `docs/overview.md` "out of scope" list now reflects reality (multi-node scheduler, zero-downtime rollouts, secrets, dashboard moved to "shipped"; API/control-plane/web-app/billing/orchestrator remain out of scope). _(The separate stale `launchpad.yaml` "reference shapes" section is still flagged in CLAUDE.md as its own rewrite.)_

---

## Already shipped (for context — not TODO)

Use this as the baseline the gaps above extend.

- **CLI:** `init`, `deploy`, `undeploy`, `rollback`, `scale`, `config`, `status`, `history`, `logs`, `secret`, `node *`, `cluster *`, global `--cluster` / `--json` / `--yes`
- **Deploy:** Docker buildx → ECR immutable tags, merge into per-node `desired.json`, convergence watch, `--env`, `--restart`, `--image` (redeploy an existing tag), `--dry-run`
- **Infra:** EC2 + EIP + SG + per-node IAM, golden AMI path, S3 state bucket, auto-provision/resume/drift repair on deploy
- **Runtime:** Agent reconcile, Caddy HTTPS, web+worker services, edge/app/both topology, replicas + rolling health-gated updates
- **Cluster placement:** omit `node`/`nodes` + `schedule`/`topology` for automatic spread across app nodes (when cluster has app nodes)
- **Secrets:** SSM SecureString + `launch-pad secret *`
- **Observability (basic):** CloudWatch logs (`logs`), agent stats (`node monitor`), local dashboard (experimental)
- **Testing:** extensive unit tests + AWS e2e fixture path

---

## Suggested implementation order

1. ~~**Config lock relief + `scale` commands**~~ — ✅ shipped (`scale`, `config set/unset`; lock now allows cpu/memory/replicas/env/secrets).
2. **DNS verify + post-deploy checklist + Cloudflare A record** — unblocks HTTPS for the common indie stack (Cloudflare DNS + EIP). ← next
3. **`node evacuate` + destroy safety + `rebalance`** — unblocks node lifecycle without orphaning prod.
4. **Doctor/preflight + AWS/CI bootstrap templates** — `launch-pad doctor` ✅ shipped; the `setup` wizard + operator-IAM/CI-OIDC templates remain.
5. **Rollback + deploy history + alerting** — production confidence after the happy path works.
