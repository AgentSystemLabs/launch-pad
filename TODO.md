# Launch Pad — roadmap (indie-hacker UX)

What is **not built yet** for the north-star flow:

> set up AWS → `lpd deploy` in a repo → auto node + HTTPS → rolling updates → easy scaling & placement

Completed work lives in [DONE.md](DONE.md). Longer-horizon ideas live in [IDEAS.md](IDEAS.md).

**Legend:** ❌ not built · ⚠️ partial / manual · ✅ exists today

---

## P0 — next up

### DNS & HTTPS

- [ ] **Optional DNS provider integrations** — a DNS-write command: provider API token → create/update an A record to the edge EIP. _(`dns verify` + post-deploy panel already ship. Route53 auto-DNS was removed — DNS is user-managed by design (one wildcard covers everything), so weigh whether any write integration is still worth it.)_
- [ ] **DNS-01 TLS for proxied domains** — support domains fronted by a proxy/CDN (Caddy DNS challenge or origin-cert path). Today a proxied record simply fails `dns verify` as `wrong-ip`, not yet a product path.

### Data & stateful apps

- [ ] **Managed data plane helpers** — optional **RDS Postgres** and **Redis** (ElastiCache) provisioning or “attach existing” wizard; wire connection strings into service `env` / `secrets`.

---

## Suggested implementation order

1. **DNS provider integrations + DNS-01 TLS** — unblocks HTTPS for stacks fronted by a managed DNS/CDN provider. `dns verify` + post-deploy panel already ship; DNS writes are user-managed by design since the Route53 removal.
2. **Managed data plane helpers** — RDS Postgres + Redis for stateful indie apps (the two most common day-one dependencies). (Named environments shipped as `deploy --env --ttl` + `launchpad destroy --env/--list-envs/--prune-expired`; monorepo "deploy changed services only" shipped as `deploy --changed <ref>`; worker scheduling shipped as `[[service]].cron`. Reactive autoscaling shipped as `launch-pad autoscale`. Remote builds shipped as `deploy --remote-build`.)
