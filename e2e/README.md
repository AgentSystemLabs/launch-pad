# launch-pad end-to-end test

A **real-AWS**, on-demand test that provisions infrastructure, deploys the
example app, exercises every part of the lifecycle, and tears everything down.
It is **not** part of `pnpm test` — it costs real money (a few cents) and takes
~10–20 minutes — so it only runs when you explicitly ask for it.

It drives the **built** CLI exactly as a user would (`node packages/cli/dist/index.js …`),
against a 1-edge + 1-app topology.

## What it verifies

1. Provisions an isolated cluster: one **edge** node (public, Caddy) + one **app**
   node (private, no public IP).
2. The app node is genuinely **private** (registry has no public IP); the edge has
   a stable **Elastic IP**.
3. Deploys v1 and confirms the service answers over **HTTPS on a real domain** with
   a valid Let's Encrypt certificate.
4. Reads service **logs** via `launch-pad logs`.
5. Reads service **CPU/memory stats** via `launch-pad node monitor`.
6. Deploys v2 (a real source change → new image) and asserts the live response
   flips v1 → v2 **with zero downtime** (continuous polling during the rollout).
7. Re-deploys the same version and asserts it is **idempotent** (no container churn).
8. **Pauses** the whole group (`cluster pause`) — both instances stop.
9. **Resumes** the group and confirms the service recovers on the same Elastic IP.
10. **Destroys** the whole group (`cluster destroy`) and confirms all S3 state is
    gone and the CLI no longer shows the cluster.

## Prerequisites

- **AWS credentials** in your environment (e.g. `AWS_PROFILE=…`, or access keys).
  The harness uses your default credential chain.
- **Docker** running locally (the CLI builds the image with `docker buildx`).
- A **Route53 hosted zone** you control that is a suffix of the test domain. By
  default the test uses `e2e-test.launch-pad.agentsystem.dev`, which requires a
  hosted zone for `launch-pad.agentsystem.dev` (or any parent). The harness
  creates the subdomain A record and deletes it on teardown.

## Running

From the repo root:

```bash
LAUNCHPAD_E2E=1 AWS_PROFILE=your-profile pnpm e2e
```

`pnpm e2e` builds the CLI first, then runs the harness.

### Options (environment / flags)

| Variable / flag          | Default                                   | Meaning                                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| `LAUNCHPAD_E2E=1`        | _(unset → skips)_                         | Required opt-in.                         |
| `LAUNCHPAD_E2E_REGION`   | `us-east-1`                               | AWS region to provision in.              |
| `LAUNCHPAD_E2E_DOMAIN`   | `e2e-test.launch-pad.agentsystem.dev`     | Test subdomain (must sit under a zone you own). |
| `--keep` / `LAUNCHPAD_E2E_KEEP=1` | _(off)_                          | Leave the cluster running after the run for inspection. |

Each run uses a unique cluster id (`e2e-<random>`) and an isolated
`LAUNCHPAD_HOME` temp dir, so it never touches your real `~/.launch-pad` config
or other clusters.

### Cleanup

Teardown runs automatically in a `finally` block even if an assertion fails. If
you passed `--keep` (or the process was killed mid-run), tear down manually — the
final log line prints the exact command, e.g.:

```bash
LAUNCHPAD_HOME=/tmp/launch-pad-home-XXXX launch-pad cluster destroy e2e-abc123 --yes
```

> `cluster destroy` removes everything it created: instances, Elastic IPs,
> security groups, per-node IAM roles + instance profiles, and all S3 state under
> the cluster prefix. (Single-node `node destroy` still leaves IAM in place for a
> same-name re-create; a full cluster teardown does not.)
