# Launch Pad — ideas (not on the core roadmap)

Items moved out of [TODO.md](TODO.md) — useful polish, advanced ops, or longer-horizon bets that are **not** central to the indie-hacker mission of shipping real apps from a laptop to your own infra. Revisit when the [P0 roadmap](TODO.md) is done or a specific need surfaces.

---

## Config & scaling ergonomics

- **Env-specific scaling override file** — override file for env-specific (`--env`) scaling without duplicating the whole TOML.
- **Auto-add node on scale-up** — parity with deploy’s auto-provision when `launch-pad scale` pushes past current capacity (deploy auto-add already covers most cases).

---

## Node & service lifecycle polish

- **Auto-evacuate on destroy** — inline auto-evacuate when `node destroy` would orphan services (today: refuse + `--force`, or run `node evacuate` first).
- **Cross-project evacuate-all** — evacuate every project’s cluster-placed services off a node in one shot.
- **Edge-routing drain for web services** — evacuate/rebalance follow-up for edge-fronted web traffic during node drain.

---

## Release safety (advanced)

- **Whole-footprint rollback** — roll back every service in a footprint to a prior deploy event (per-service `rollback` + deploy history already ship).
- **Canary / blue-green** — beyond single-service rolling surge.

---

## Observability & alerting (beyond on-demand checks)

- **External uptime check** — synthetic HTTPS probe independent of the node (or integrated Route53 health check). `alerts check` on a schedule covers much of this today.
- **Continuous monitoring** — always-on alerting (not just on-demand `alerts check`).
- **Cert renewal failure alerts** — detect Let's Encrypt / Caddy cert issuance or renewal failures.
- **Node drift signals** — alert when live node state diverges from desired (beyond heartbeat staleness).

---

## Data & durability (beyond node-local volumes)

- **EBS volume attach** — cross-node-failure durability for persistent data (named docker volumes survive container replace on the same node today).

---

## Security & multi-tenant ops

- **Cross-account clusters** — `cluster create --role-arn` is saved locally but explicitly “Phase 2 / not activated”.
- **Edge hardening options** — rate limits, basic WAF (or deeper Cloudflare integration), IP allowlists — none in product surface (many indies front with Cloudflare already).

---

## Cost visibility (beyond CLI)

- **Live/hosted cost dashboard** — on-demand CLI estimate ships; a hosted view is still future.
- **Native AWS Budgets integration** — CLI `--budget` gate ships; AWS Budgets wiring is still future.

---

## Platform & ecosystem

- **Multi-region** — single project spanning regions (or documented “one cluster = one region” with failover story).
- **Custom domains at scale** — wildcard certs, apex + www, multiple domains per service without hand-editing Caddy.
- **Static assets / CDN** — S3+CloudFront or “static service” type for SPAs without a container (often solved with Cloudflare or a tiny nginx sidecar).
- **Control-plane API** — remote deploy triggers, team RBAC, audit (deliberately out of scope — declarative S3 contract, no vendor server).

---

## Developer experience polish

- **Init follow-ups** — framework-specific health-check path scaffolding + a multi-service monorepo template (`init` detection already ships).
- **Doctor IAM probes** — per-permission IAM dry-runs (EIP/IAM/SSM) and quota checks beyond today's pass/warn/fail checks.

---

## Docs maintenance

- **Stale `launchpad.yaml` reference shapes** — `docs/overview.md` still shows a single-service YAML example; real schema is `launch-pad.toml` in `shared/src/config.ts` (flagged in CLAUDE.md).
