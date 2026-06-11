# Launch Pad — roadmap (indie-hacker UX)

What is **not built yet** for the north-star flow:

> set up AWS → `lpd deploy` in a repo → auto node + HTTPS → rolling updates → easy scaling & placement

Completed work lives in [DONE.md](DONE.md). Longer-horizon ideas live in [IDEAS.md](IDEAS.md).

**Legend:** ❌ not built · ⚠️ partial / manual · ✅ exists today

---

## P0 — next up

### DNS & HTTPS

- [ ] **Cloudflare one-click A record** — `launch-pad dns setup` (or deploy flag): OAuth/API token → create/update **DNS-only** A record to edge/both EIP; link out to Cloudflare dashboard for token setup. _(Route53 + `dns verify` + post-deploy panel already ship; `dns verify` detects the orange-cloud footgun.)_
- [ ] **Cloudflare-proxied / DNS-01 TLS** — support orange-cloud domains (Caddy DNS challenge or Cloudflare origin cert path). Today proxied DNS is a detected footgun, not yet a product path.

### Capacity & node autoscaling

- [ ] **Reactive autoscaling policy** — declarative min/max app nodes and/or max replicas based on CPU/memory headroom or schedule (even simple “maintain N app nodes” would help).
- [ ] **Non-disruptive vertical scale** — `node resize` today stops the instance; explore rolling evacuate → replace → rebalance.

### CI/CD

- [ ] **Remote build** — deploy without local Docker (CodeBuild / ECR build pipeline / pre-built image deploy) for slim CI runners.

### Data & stateful apps

- [ ] **Managed data plane helpers** — optional **RDS Postgres** and **Redis** (ElastiCache) provisioning or “attach existing” wizard; wire connection strings into service `env` / `secrets`.

### Developer experience

- [ ] **Monorepo / multi-service deploy** — first-class “deploy changed services only” (git diff → `--service` list).
- [ ] **Preview environments** — `deploy --env pr-123` with automatic DNS pattern + TTL teardown (env flag exists; full PR lifecycle automation does not).

### Workers

- [ ] **Worker scheduling (cron)** — an agent should run a container periodically; cron / periodic jobs as a first-class service type (not just long-running workers).

---

## Suggested implementation order

1. **Cloudflare one-click A record + DNS-01 TLS** — unblocks HTTPS for the common indie stack (Cloudflare DNS + EIP). Route53 + verify + post-deploy panel already ship.
2. **Reactive autoscaling + non-disruptive resize** — closes the gap between manual `scale` and hands-off node pool management.
3. **Remote build** — slim CI runners without local Docker.
4. **Managed data plane helpers** — RDS Postgres + Redis for stateful indie apps (the two most common day-one dependencies).
5. **Preview environments + monorepo deploy** — team/PR workflows on top of the happy path.
6. **Worker scheduling (cron)** — periodic jobs (cleanup, digests, billing runs) without a separate cron host.
