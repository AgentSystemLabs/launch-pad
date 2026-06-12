/**
 * launchpad real-AWS end-to-end test.
 *
 * Gated, on-demand (NOT part of `pnpm test`). Drives the *built* CLI as a
 * subprocess against real AWS for a 1-edge + 1-app topology, and asserts the
 * full lifecycle: provision → deploy → HTTPS via a real domain → logs → stats →
 * zero-downtime rollout → idempotent re-deploy → pause → resume → destroy.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e   (add `--keep` to skip teardown)
 * See e2e/README.md for prerequisites.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { type Cli, makeCli } from "./cli";
import { makeDns } from "./dns";
import { type Fixture, prepareFixture } from "./fixture";
import { pollHttps, tcpProbe, ZeroDowntimePoller } from "./http";
import { assert, assertEquals, log, note, printSummary, softStep, step } from "./report";

// ── tunables ──────────────────────────────────────────────────────────────────
const CERT_TIMEOUT_MS = 10 * 60_000; // DNS propagation + Let's Encrypt issuance
const ZERO_DOWNTIME_MAX_FAILURE_RATE = 0.01; // ≤1% of in-flight requests may blip
const ZERO_DOWNTIME_MAX_CONSECUTIVE = 3; // a run of ≥3 failures = a real outage
const DEPLOY_TIMEOUT_S = "600";
const SECRET_KEY = "LAUNCHPAD_E2E_SECRET";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── parsed CLI JSON shapes (only the fields we assert on) ───────────────────────
interface NodeShow {
  node: {
    nodeId: string;
    role: string;
    publicIp: string | null;
    privateIp: string | null;
    securityGroupId: string | null;
    instanceId: string | null;
    state: string;
  };
  ec2: { state: string; drift: string } | null;
  status: { services: Array<{ replicas?: Array<{ containerId: string | null }> }> } | null;
}
interface LogsJson {
  logGroup: string;
  events: Array<{ message: unknown }>;
}
interface MonitorJson {
  samples: unknown[];
}
interface DestroyJson {
  cluster: string;
  destroyed: string[];
  warnings: string[];
}
interface ClusterCreateJson {
  bucket: string;
}

async function retry<T>(
  fn: () => Promise<T>,
  opts: { tries: number; delayMs: number; until: (r: T) => boolean },
): Promise<T> {
  let last = await fn();
  for (let i = 1; i < opts.tries && !opts.until(last); i += 1) {
    await sleep(opts.delayMs);
    last = await fn();
  }
  return last;
}

async function containerIds(cli: Cli, node: string, cluster: string): Promise<string[]> {
  const show = await cli.json<NodeShow>(["node", "show", node, "--cluster", cluster]);
  return (show.status?.services ?? [])
    .flatMap((s) => (s.replicas ?? []).map((r) => r.containerId))
    .filter((id): id is string => !!id)
    .sort();
}

async function countS3Objects(region: string, bucket: string, prefix: string): Promise<number> {
  const s3 = new S3Client({ region });
  let count = 0;
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    count += res.Contents?.length ?? 0;
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function readDesiredJson(region: string, bucket: string, cluster: string, node: string): Promise<unknown> {
  const s3 = new S3Client({ region });
  const key = `clusters/${cluster}/nodes/${node}/desired.json`;
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  if (!body) throw new Error(`empty desired.json at s3://${bucket}/${key}`);
  return JSON.parse(body) as unknown;
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e   (see e2e/README.md)\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const domain = process.env.LAUNCHPAD_E2E_DOMAIN ?? "e2e-test.launch-pad.agentsystem.dev";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-${runId}`;
  const edgeNode = "e2e-edge";
  const appNode = "e2e-app";
  const project = "e2e";
  const service = "web";
  const port = 3000;
  const v1 = `e2e-v1-${runId}`;
  const v2 = `e2e-v2-${runId}`;
  const secretV1 = `e2e-secret-v1-${runId}`;
  const secretV2 = `e2e-secret-v2-${runId}`;
  const url = `https://${domain}/`;
  const secretUrl = `https://${domain}/secret`;

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });
  const dns = makeDns(region);

  let bucket = "";
  let edgeIp = "";
  let zoneId = "";
  let fixture: Fixture | undefined;

  note(`run ${runId} · cluster ${cluster} · region ${region} · ${domain}`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the whole group + clean up state", async () => {
      if (zoneId && edgeIp) {
        try {
          await dns.deleteA(zoneId, domain, edgeIp);
          log("DNS record removed");
        } catch (error) {
          log(`DNS cleanup warning: ${(error as Error).message}`);
        }
      }
      if (fixture) {
        const rm = await cli.run(
          ["secret", "rm", SECRET_KEY, "--service", service, "--cluster", cluster],
          { cwd: fixture.dir, allowFail: true },
        );
        if (rm.exitCode === 0) log("SSM secret removed");
        else log(`SSM secret cleanup warning: ${rm.stderr || rm.stdout}`);
      }
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      note(`destroyed nodes: ${out.destroyed.join(", ") || "(none)"}`);
      assert(
        out.warnings.length === 0,
        `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`,
      );
      if (bucket) {
        const remaining = await countS3Objects(region, bucket, `clusters/${cluster}/`);
        assertEquals(remaining, 0, "no S3 state remains under the cluster prefix");
      }
      const show = await cli.run(["cluster", "show", cluster], { allowFail: true });
      assert(show.exitCode !== 0, "CLI no longer shows the cluster (local target removed)");
    }).catch(() => {
      /* teardown failure is recorded as a failed step; keep cleaning up */
    });
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    if (fixture) {
      try {
        rmSync(fixture.dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    await step("create an isolated cluster", async () => {
      const out = await cli.json<ClusterCreateJson>(["cluster", "create", cluster, "--region", region]);
      bucket = out.bucket;
      assert(!!bucket, "cluster create returned a state bucket");
      note(`state bucket: ${bucket}`);
    });

    await step("provision the edge node (public)", async () => {
      await cli.run(["node", "create", edgeNode, "--role", "edge", "--cluster", cluster, "--yes"]);
      const show = await cli.json<NodeShow>(["node", "show", edgeNode, "--cluster", cluster]);
      assertEquals(show.node.role, "edge", "edge node role is `edge`");
      assert(!!show.node.publicIp, "edge node has a public (Elastic) IP");
      edgeIp = show.node.publicIp!;
      note(`edge public IP: ${edgeIp}`);
    });

    await step("provision the app node (private)", async () => {
      await cli.run([
        "node", "create", appNode, "--role", "app", "--edge", edgeNode, "--cluster", cluster, "--yes",
      ]);
      const show = await cli.json<NodeShow>(["node", "show", appNode, "--cluster", cluster]);
      assertEquals(show.node.role, "app", "app node role is `app`");
      assert(!!show.node.privateIp, "app node has a private IP for the edge to dial");
      // App nodes get a public IP for EGRESS only (launchpad provisions no NAT /
      // VPC endpoints, so they need outbound to pull from ECR + read S3). Privacy
      // is enforced at the INBOUND edge by the security group, which admits only
      // the edge SG — so the internet can't open ANY port. A security-group drop
      // surfaces as a connect timeout (not a refusal).
      const ip = show.node.publicIp;
      if (ip) {
        const ports = [80, 443, 3000];
        const results = await Promise.all(ports.map((p) => tcpProbe(ip, p)));
        ports.forEach((p, i) => {
          assert(results[i] !== "open", `app node inbound :${p} is NOT publicly reachable (got ${results[i]})`);
        });
        note(`app egress IP ${ip}: inbound firewalled on ${ports.join("/")} (${results.join("/")})`);
      } else {
        note("app node has no public IP at all");
      }
    });

    fixture = await prepareFixture({
      project, service, domain, port, replicas: 2, cpu: 256, memory: 256,
    });

    await step("set an SSM secret via the CLI and register it in launch-pad.toml", async () => {
      await cli.run(["secret", "set", SECRET_KEY, "--service", service, "--cluster", cluster], {
        cwd: fixture!.dir,
        input: `${secretV1}\n`,
      });
    });

    await step("deploy v1", async () => {
      const sha = await fixture!.setRelease(v1);
      note(`v1 source sha: ${sha}`);
      await cli.run(["deploy", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S], {
        cwd: fixture!.dir,
      });
    });

    await step("desired state contains only secret refs (not plaintext)", async () => {
      const desired = await readDesiredJson(region, bucket, cluster, appNode);
      const encoded = JSON.stringify(desired);
      assert(encoded.includes(`"/launch-pad/${cluster}/${project}/${service}/${SECRET_KEY}"`), "desired.json includes the SSM secret ref path");
      assert(encoded.includes(`"name":"${SECRET_KEY}"`), "desired.json includes the env key name");
      assert(!encoded.includes(secretV1), "desired.json does NOT contain the plaintext secret value");
    });

    await step("point DNS at the edge (as the user would) and verify HTTPS (v1)", async () => {
      // Harness-only: the edge's EIP is freshly allocated this run, so the harness
      // plays the user's "point your domain at the edge" step via Route53.
      zoneId = await dns.findZoneId(domain);
      const changeId = await dns.upsertA(zoneId, domain, edgeIp);
      await dns.waitInsync(changeId);
      note("DNS INSYNC — waiting for Let's Encrypt cert issuance + service…");
      const res = await pollHttps(url, { timeoutMs: CERT_TIMEOUT_MS, bodyIncludes: v1 });
      assert(
        res.ok,
        `HTTPS served v1 over a valid certificate (attempts: ${res.attempts}${res.lastError ? `, last: ${res.lastError}` : ""})`,
      );
      const secret = await pollHttps(secretUrl, { timeoutMs: 120_000, bodyIncludes: `secret:${secretV1}` });
      assert(secret.ok, `container received the SSM secret via env (attempts: ${secret.attempts})`);
    });

    await step("rotate the SSM secret and roll containers with deploy --restart", async () => {
      const before = await containerIds(cli, appNode, cluster);
      assert(before.length > 0, `captured ${before.length} container id(s) before secret rotation`);
      await cli.run(["secret", "set", SECRET_KEY, "--service", service, "--cluster", cluster], {
        cwd: fixture!.dir,
        input: `${secretV2}\n`,
      });
      await cli.run(["deploy", "--restart", "--service", service, "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S], {
        cwd: fixture!.dir,
      });
      const after = await containerIds(cli, appNode, cluster);
      assert(before.join(",") !== after.join(","), "deploy --restart rolled containers after secret rotation");
      const secret = await pollHttps(secretUrl, { timeoutMs: 120_000, bodyIncludes: `secret:${secretV2}` });
      assert(secret.ok, `container received the rotated SSM secret via env (attempts: ${secret.attempts})`);
    });

    await softStep("scale replicas up (2 → 3) and back down (3 → 2) via the CLI", async () => {
      // The fixture deployed with replicas: 2. `scale` edits launch-pad.toml and runs
      // a --service deploy — so this also proves the config lock now PERMITS a replicas
      // change (an allowlisted post-deploy mutation) instead of aborting the build.
      const before = await containerIds(cli, appNode, cluster);
      assertEquals(before.length, 2, "service is running 2 replicas before scaling");

      await cli.run(
        ["scale", "replicas", service, "3", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: fixture!.dir },
      );
      const up = await retry(() => containerIds(cli, appNode, cluster), {
        tries: 12,
        delayMs: 10_000,
        until: (ids) => ids.length === 3,
      });
      assertEquals(up.length, 3, "agent converged to 3 running replicas after scale-up");
      const serving = await pollHttps(url, { timeoutMs: 120_000, bodyIncludes: v1 });
      assert(serving.ok, `still serving over HTTPS with 3 replicas (attempts: ${serving.attempts})`);

      await cli.run(
        ["scale", "replicas", service, "2", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: fixture!.dir },
      );
      const down = await retry(() => containerIds(cli, appNode, cluster), {
        tries: 12,
        delayMs: 10_000,
        until: (ids) => ids.length === 2,
      });
      assertEquals(down.length, 2, "agent converged back to 2 running replicas after scale-down");

      // The CLI wrote the count back into launch-pad.toml — leave it at 2 so the
      // subsequent v2 rollout uses the same replica count it started with.
      const toml = readFileSync(join(fixture!.dir, "launch-pad.toml"), "utf8");
      assert(/replicas\s*=\s*2\b/.test(toml), "launch-pad.toml replicas is back to 2 after the scale-down");
    });

    await softStep("set a non-secret env var with `config set` and roll it out", async () => {
      // `config set` edits the service's env table + redeploys; the agent must roll
      // the containers (env is part of the config stamp) and the new value must reach
      // the container. The fixture echoes any LAUNCHPAD_E2E_* env at /secret-style
      // routes — here we assert a fresh rollout happened (new container ids).
      const before = await containerIds(cli, appNode, cluster);
      await cli.run(
        ["config", "set", service, "LAUNCHPAD_E2E_FLAG=on", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: fixture!.dir },
      );
      const after = await retry(() => containerIds(cli, appNode, cluster), {
        tries: 12,
        delayMs: 10_000,
        until: (ids) => ids.length === before.length && ids.join(",") !== before.join(","),
      });
      assert(
        after.length === before.length && after.join(",") !== before.join(","),
        "config set rolled the containers (new ids) to apply the env change",
      );
      const toml = readFileSync(join(fixture!.dir, "launch-pad.toml"), "utf8");
      assert(/LAUNCHPAD_E2E_FLAG\s*=\s*"on"/.test(toml), "launch-pad.toml carries the new env var");
    });

    await softStep("inspect service logs via the CLI", async () => {
      // The CloudWatch agent tails container files from the END, so we generate
      // request traffic (the fixture logs each request) to produce log lines AFTER
      // the agent starts tailing — then read them back through the CLI.
      let out: LogsJson = { logGroup: "", events: [] };
      for (let i = 0; i < 10; i += 1) {
        await Promise.all(
          Array.from({ length: 5 }, () => pollHttps(url, { timeoutMs: 8000 }).catch(() => null)),
        );
        out = await cli.json<LogsJson>(["logs", service, "--cluster", cluster, "--since", "1h"], {
          cwd: fixture!.dir,
        });
        if (out.events.length > 0) break;
        await sleep(20_000);
      }
      assert(out.events.length > 0, `logs returned ${out.events.length} event(s) from CloudWatch`);
      assert(
        out.events.some((e) => /listening|request/i.test(String(e.message))),
        "logs include application output (boot or request lines)",
      );
    });

    await softStep("inspect service stats via the CLI", async () => {
      const out = await retry(
        () => cli.json<MonitorJson>(["node", "monitor", appNode, "--cluster", cluster, "--since", "1h"], { cwd: fixture!.dir }),
        { tries: 10, delayMs: 30_000, until: (o) => o.samples.length > 0 },
      );
      assert(out.samples.length > 0, `node monitor returned ${out.samples.length} CPU/memory sample(s)`);
    });

    await softStep("deploy v2 with ZERO downtime", async () => {
      const poller = new ZeroDowntimePoller(url);
      poller.start();
      try {
        const sha = await fixture!.setRelease(v2);
        note(`v2 source sha: ${sha}`);
        await cli.run(["deploy", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S], {
          cwd: fixture!.dir,
        });
        const settle = await pollHttps(url, { timeoutMs: 120_000, bodyIncludes: v2 });
        assert(settle.ok, "service serves v2 after the rollout");
      } finally {
        await poller.stop();
      }
      const stats = poller.stats();
      const v1seen = poller.countWith(v1);
      const v2seen = poller.countWith(v2);
      note(
        `rollout samples: ${stats.total} · failures: ${stats.failures} (${(stats.failureRate * 100).toFixed(2)}%) · ` +
          `max consecutive: ${stats.maxConsecutiveFailures} · v1 seen: ${v1seen} · v2 seen: ${v2seen}`,
      );
      // Surface WHAT each failed sample was: a 5xx (edge routed to a dead replica —
      // a real rollout bug) reads very differently from a transport-level error
      // (keep-alive reuse race on a Caddy reload, or plain internet noise).
      const failed = poller.samples
        .map((sample, index) => ({ sample, index }))
        .filter((f) => !f.sample.ok);
      for (const f of failed.slice(0, 10)) {
        const s = f.sample;
        note(
          `failed sample #${f.index} at ${s.at}: ` +
            (s.status != null
              ? `status ${s.status}, body: ${s.body.slice(0, 120)}`
              : `error: ${s.error}`),
        );
      }
      assert(v1seen > 0, "poller observed the OLD (v1) version before the cutover");
      assert(v2seen > 0, "poller observed the NEW (v2) version after the cutover");
      assert(
        stats.failureRate <= ZERO_DOWNTIME_MAX_FAILURE_RATE,
        `failure rate ${(stats.failureRate * 100).toFixed(2)}% ≤ ${ZERO_DOWNTIME_MAX_FAILURE_RATE * 100}%`,
      );
      assert(
        stats.maxConsecutiveFailures < ZERO_DOWNTIME_MAX_CONSECUTIVE,
        `no sustained outage (max consecutive failures ${stats.maxConsecutiveFailures} < ${ZERO_DOWNTIME_MAX_CONSECUTIVE})`,
      );
    });

    await softStep("re-deploy the same version is idempotent (no container churn)", async () => {
      const before = await containerIds(cli, appNode, cluster);
      assert(before.length > 0, `app node reports ${before.length} running container(s)`);
      await cli.run(["deploy", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S], {
        cwd: fixture!.dir,
      });
      const after = await containerIds(cli, appNode, cluster);
      assertEquals(after.join(","), before.join(","), "container ids unchanged after a same-version re-deploy");
    });

    await softStep("pause the whole group", async () => {
      await cli.run(["cluster", "pause", cluster, "--yes"]);
      for (const n of [edgeNode, appNode]) {
        const show = await cli.json<NodeShow>(["node", "show", n, "--cluster", cluster]);
        assertEquals(show.node.state, "stopped", `${n} registry state is "stopped"`);
        assert(
          show.ec2?.state === "stopped" || show.ec2?.state === "stopping",
          `${n} EC2 instance is stopped (saw "${show.ec2?.state}")`,
        );
      }
    });

    await softStep("resume the group and verify recovery", async () => {
      await cli.run(["cluster", "resume", cluster, "--yes"]);
      const show = await cli.json<NodeShow>(["node", "show", edgeNode, "--cluster", cluster]);
      assertEquals(show.node.publicIp, edgeIp, "edge Elastic IP is unchanged across pause/resume");
      const res = await pollHttps(url, { timeoutMs: 5 * 60_000, bodyIncludes: v2 });
      assert(res.ok, `service serves v2 again after resume (attempts: ${res.attempts})`);
    });
  } finally {
    if (keep) {
      note(`--keep set — leaving cluster "${cluster}" running. Tear it down later with:`);
      note(`  LAUNCHPAD_HOME=${home} launchpad cluster destroy ${cluster} --yes`);
    } else {
      await teardown();
    }
  }

  return true;
}

main()
  .then((ran) => {
    if (!ran) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = printSummary() ? 0 : 1;
  })
  .catch((error) => {
    process.stderr.write(`\n${error?.stack ?? String(error)}\n`);
    // A failed step is already recorded; the summary reflects it.
    process.exitCode = printSummary() ? 1 : 1;
  });
