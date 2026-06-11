# The indie-hacker happy path

A single end-to-end walkthrough: from an empty AWS account to a deployed app with HTTPS,
then the day-two operations you'll actually use — scaling, secrets, rollbacks, adding a node,
and tearing things down safely. Every command here is real; deeper references live in
[cli.md](cli.md) and [configuration.md](configuration.md).

> **The mental model.** The CLI writes your *desired state* to S3; an agent on each node polls
> S3 and reconciles Docker + Caddy to match. There's no control-plane server — see
> [architecture.md](architecture.md). Everything runs in **your** AWS account.

---

## 0. Prerequisites (once)

- **Docker** running locally (with `buildx`) — images build for `linux/amd64`.
- **AWS credentials** for an IAM user/role with rights to EC2, IAM, S3, ECR, SSM, STS, and
  CloudWatch Logs in your target region (see [getting-started.md](getting-started.md#aws-account)).
- A **domain** you control, if you want HTTPS (a registrar + a DNS host you can edit).

Check everything is wired up before spending a cent — this provisions nothing:

```bash
npx @agentsystemlabs/launch-pad doctor
```

`doctor` verifies Docker + buildx, your AWS identity/region, the state bucket, ECR access, a
default VPC, and a usable AMI — pass/warn/fail per check, non-zero exit on any fail (so it's
CI-gateable).

---

## 1. Scaffold and first deploy

From your app's repo:

```bash
npx @agentsystemlabs/launch-pad init      # writes a launch-pad.toml (detects your setup)
```

A minimal single web service `launch-pad.toml`:

```toml
project = "my-app"

[[service]]
name = "web"
node = "node-prod-1"          # the machine to run on (auto-created if missing)
dockerfile = "Dockerfile"
context = "."
domain = "app.example.com"    # makes this a web service (Caddy + HTTPS)
port = 3000
replicas = 2

[service.healthCheck]         # required for every web service
path = "/healthz"
```

Then:

```bash
npx @agentsystemlabs/launch-pad deploy --yes
```

`deploy` builds your image, pushes it to ECR with an **immutable** content-addressed tag,
**auto-provisions** the missing node (a confirmation prompt unless `--yes`), publishes desired
state, and waits for the agent to report convergence. It prints a **Placement** panel (where
replicas landed) and a **DNS panel** with the exact A-record target.

---

## 2. Point DNS and get HTTPS

The DNS panel shows the node's (or its edge's) **Elastic IP**. At your DNS host:

1. Create an **A record** for `app.example.com` → that Elastic IP.
2. Keep it **DNS-only** — a Cloudflare **proxied** (orange-cloud) record breaks Let's Encrypt
   HTTP-01 issuance.

**Using AWS Route53?** Skip the manual step — let launch-pad write the record (DNS-only) for you:

```bash
npx @agentsystemlabs/launch-pad dns setup --wait
```

It points every web domain at its fronting node's Elastic IP, and is a no-op if the record is
already correct. For Cloudflare / another registrar, add the grey-cloud A record by hand.

Either way, verify the record resolves correctly (and catch the orange-cloud footgun):

```bash
npx @agentsystemlabs/launch-pad dns verify app.example.com
```

Once the A record resolves directly to the node, Caddy obtains a certificate automatically and
`https://app.example.com` is live.

---

## 3. Ship updates (rolling, zero-downtime)

Commit a change and deploy again:

```bash
npx @agentsystemlabs/launch-pad deploy --yes
```

Because the image tag is content-addressed, a new build gets a new tag and the agent does a
**health-gated rolling update** — a surged replica must pass its health check before it joins
the load balancer, so even `replicas = 1` rolls without downtime. Re-deploying the same content
is a no-op (no container churn).

Watch it any time:

```bash
npx @agentsystemlabs/launch-pad status
npx @agentsystemlabs/launch-pad logs web --follow
```

---

## 4. Day-two operations

After the first deploy, a project's **identity** is frozen by the
[config lock](configuration.md#config-lock) — but the **operational** fields stay editable.

**Scale** (horizontal or vertical) — edits `launch-pad.toml` and rolls it out:

```bash
npx @agentsystemlabs/launch-pad scale replicas web 4
npx @agentsystemlabs/launch-pad scale cpu web 512        # vCPU shares (1024 = 1 vCPU)
```

**Config & secrets** — non-secret config in `env`, secret values in SSM:

```bash
npx @agentsystemlabs/launch-pad config set web LOG_LEVEL=debug
npx @agentsystemlabs/launch-pad secret set DATABASE_URL --service web   # hidden prompt → SSM
npx @agentsystemlabs/launch-pad deploy --restart --service web          # roll to pick it up
```

**Rollback** — redeploy the previous immutable build (no rebuild), or a specific tag:

```bash
npx @agentsystemlabs/launch-pad rollback --service web            # to the previous build
npx @agentsystemlabs/launch-pad rollback --service web --to sha-abc123
```

**History** — who deployed what, when, and whether it converged:

```bash
npx @agentsystemlabs/launch-pad history --service web
```

---

## 5. CI/CD

Deploy from CI by passing `--yes` (skips every prompt) and a generous timeout:

```bash
npx @agentsystemlabs/launch-pad deploy --yes --timeout 600
```

Run `launch-pad doctor` as a pre-flight gate (non-zero exit fails the job). Use a long-lived
IAM user's keys, or — preferred — an OIDC-assumed deploy role (an official GitHub Action +
OIDC template are on the [roadmap](../TODO.md)). The CLI builds with Docker, so the runner
needs Docker available.

---

## 6. Grow to more than one box

For multiple machines, use a **named cluster** and let Launch Pad place services across its
app nodes. Omit `node`/`nodes` on a service so it's cluster-placed.

The quickest start: create the cluster, point your deploy at it, and let the **first deploy
bootstrap a node** for you (just like the single-box flow) — then grow the pool when you need to:

```bash
npx @agentsystemlabs/launch-pad cluster create prod --region us-east-1
npx @agentsystemlabs/launch-pad cluster use prod      # make it the default target
npx @agentsystemlabs/launch-pad deploy --yes          # auto-creates app-1, deploys onto it
```

For a **split** topology (private app nodes behind a dedicated edge — `topology = "split"`),
create the edge and app nodes up front, since that shape needs more than one box:

```bash
npx @agentsystemlabs/launch-pad node create edge-1 --role edge --cluster prod
npx @agentsystemlabs/launch-pad cluster set-edge prod edge-1
npx @agentsystemlabs/launch-pad node create app-1 --role app --cluster prod
npx @agentsystemlabs/launch-pad node create app-2 --role app --cluster prod
```

```toml
[[service]]
name = "web"
# no node/nodes → cluster-placed
schedule = "even"        # round-robin across the app pool ("capacity" = bin-pack)
topology = "split"       # app nodes behind a dedicated edge ("co-located" = one both node)
domain = "app.example.com"
port = 3000
replicas = 4
[service.healthCheck]
path = "/healthz"
```

A full `deploy` replans placement across the **current** app pool, so adding `app-3` and
re-deploying can spread replicas onto it (cluster-placed services only — pinned `node`/`nodes`
services never move). See [configuration.md](configuration.md) for the placement rules.

---

## 7. Tear down safely

**Remove a service** the config lock would otherwise freeze — drops it from its nodes and
trims the lock baseline so removing its `[[service]]` block then deploys cleanly:

```bash
npx @agentsystemlabs/launch-pad undeploy --service worker
# then delete the [[service]] worker block from launch-pad.toml
```

**Remove a whole project:**

```bash
npx @agentsystemlabs/launch-pad undeploy          # clears the footprint (and its lock baseline)
```

**Destroy a node** — it fully tears down the instance, Elastic IP, security group, **per-node
IAM**, and S3 state. It **refuses** if the node still hosts scheduled services (so you can't
orphan a running app); move them first, or pass `--force`:

```bash
npx @agentsystemlabs/launch-pad node destroy app-2
```

**Destroy the whole cluster** (every node + all IAM, in one go):

```bash
npx @agentsystemlabs/launch-pad cluster destroy prod --yes
```

**Pause to save money** without losing the node (edge/both keep their Elastic IP):

```bash
npx @agentsystemlabs/launch-pad node pause app-1     # … node resume app-1 later
```

---

## Where to go next

- [cli.md](cli.md) — every command and flag.
- [configuration.md](configuration.md) — the full `launch-pad.toml` schema, placement, the
  config lock, environments, and secrets.
- [architecture.md](architecture.md) — how the S3 contract, node roles, and edge routing work.
- [getting-started.md](getting-started.md) — prerequisites and AWS permissions in detail.
