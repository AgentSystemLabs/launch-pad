/**
 * launchpad real-AWS regression for reactive autoscaling (`launchpad autoscale`).
 *
 * Worker-only (no domain/cert/DNS) but it builds + deploys (needs Docker). The worker is
 * a BURN-toggled MEMORY load: `BURN=1` allocates and holds ~1.3 GB, `BURN=0` idles.
 * Memory, not CPU, drives the trigger because burstable (t3) instances launch with no
 * CPU credits in standard mode and throttle a busy loop to the ~20%/vCPU baseline —
 * an earlier CPU-based version of this harness observed a full-core spin as just 25%
 * host CPU. Held memory is throttle-proof: on the t3.medium (4 GB) bootstrap node the
 * burn reads ~30-34% host memory (≥ the 25% scale-out threshold) and the idle
 * baseline (~10-13%) sits below it and far below the 60% scale-in line.
 * (On a t3.small the idle memory baseline is ~32%, too close to any workable threshold.)
 *
 * Flow:  deploy idle worker (bootstraps edge-1 + one generated-name app node; the edge is never a scale
 * candidate) → policy 25/10 → `run` is a no-op while idle → BURN=1 → `run` provisions
 * a second app node (behind the cluster edge) → second `run` refuses (at maxNodes) →
 * BURN=0 + scale replicas 2 (spread 1+1 proves the new node serves workloads) → policy 90/60 →
 * `run` drains the least-utilized app node (its replica MOVES to the survivor before
 * teardown — zero-orphan) and terminates it → `run` again holds at minNodes.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:autoscale   (`--keep` skips teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { type Cli, listAppNodeIds, makeCli } from "./cli";
import { assert, assertEquals, note, printSummary, step } from "./report";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DEPLOY_TIMEOUT_S = "600";
const GIT_ID = ["-c", "user.email=e2e@launch-pad.test", "-c", "user.name=launchpad e2e"];

interface NodeShow {
  node: { nodeId: string; role: string; state: string };
  status: {
    services: Array<{ service: string; replicas?: Array<{ containerId: string | null; state: string }> }>;
  } | null;
}
interface AutoscaleResult {
  action: string;
  node?: string;
  victim?: string;
  reason?: string;
  dryRun?: boolean;
}
interface DestroyJson {
  destroyed: string[];
  warnings: string[];
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

/** Running replica count for a service on one node (0 if the node doesn't exist). */
async function runningOn(cli: Cli, node: string, cluster: string, service: string): Promise<number> {
  const res = await cli.run(["node", "show", node, "--cluster", cluster, "--json"], { allowFail: true });
  if (res.exitCode !== 0) return 0;
  const show = JSON.parse(res.stdout) as NodeShow;
  const svc = (show.status?.services ?? []).find((s) => s.service === service);
  return (svc?.replicas ?? []).filter((r) => r.state === "running" && r.containerId).length;
}

async function nodeExists(cli: Cli, node: string, cluster: string): Promise<boolean> {
  const res = await cli.run(["node", "show", node, "--cluster", cluster, "--json"], { allowFail: true });
  return res.exitCode === 0;
}

/**
 * A cluster-auto-placed worker whose MEMORY load is toggled by the (operationally
 * mutable) BURN env var. memory=1024 sizes the bootstrap node to a t3.medium
 * (steady 1024 + surge 1024 = 2048 MB > a t3.small's 1536 MB allocatable) while
 * keeping TWO replicas absorbable by ONE t3.medium (2048 steady + 1024 surge =
 * 3072 ≤ 3584 allocatable) — required or the scale-in planner's reservation
 * feasibility check would (correctly) refuse to drain the second node.
 */
function prepareFixture(spec: { project: string; service: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "launch-pad-autoscale-"));
  writeFileSync(
    join(dir, "Dockerfile"),
    ["FROM node:24-alpine", "WORKDIR /app", "COPY server.js ./", 'CMD ["node", "server.js"]', ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "server.js"),
    `// BURN=1 → allocate and HOLD ~1.3 GB (memory pressure is throttle-proof on t3,
// unlike CPU, which standard-mode credit exhaustion caps at the ~20%/vCPU baseline).
const burn = process.env.BURN === "1";
console.log("autoscale e2e worker up, burn=" + burn);
process.on("SIGTERM", () => { console.log("worker draining"); process.exit(0); });
const held = [];
if (burn) {
  const targetMb = 825; // under the 1024 MB cgroup limit incl. node's own footprint
  for (let i = 0; i < Math.floor(targetMb / 55); i += 1) held.push(Buffer.alloc(55 * 1024 * 1024, 1));
  console.log("holding " + targetMb + "MB");
}
setInterval(() => console.log("tick held=" + held.length), 60_000);
`,
    "utf8",
  );
  writeFileSync(
    join(dir, "launch-pad.toml"),
    `# Generated by the launchpad autoscale e2e — do not edit.
project = "${spec.project}"

[[service]]
name = "${spec.service}"
dockerfile = "Dockerfile"
context = "."
cpu = 256
memory = 1024
replicas = 1
env = { NODE_ENV = "production", BURN = "0" }
`,
    "utf8",
  );
  return dir;
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS autoscale e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:autoscale\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-autoscale-${runId}`;
  const project = "autoscale";
  const service = "worker";
  const edgeNode = "edge-1"; // bootstrapped by the first deploy; never a scale-in candidate
  let node1 = ""; // bootstrap app node (generated name, discovered after the first deploy)
  let node2 = ""; // added by scale-out (generated name), removed by scale-in

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });
  const dir = prepareFixture({ project, service });

  note(`run ${runId} · cluster ${cluster} · region ${region} · reactive autoscaling`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", [...GIT_ID, "add", "-A"], { cwd: dir });
  await execa("git", [...GIT_ID, "commit", "-q", "-m", "autoscale e2e fixture"], { cwd: dir });

  const teardown = async (): Promise<void> => {
    await step("destroy the cluster + clean up state", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      note(`destroyed nodes: ${out.destroyed.join(", ") || "(none)"}`);
      assert(
        out.warnings.length === 0,
        `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`,
      );
    }).catch(() => {
      /* recorded as a failed step; keep cleaning up */
    });
    try {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  const autoscaleArgs = (extra: string[]): string[] => ["autoscale", ...extra, "--cluster", cluster];

  try {
    await step("create an isolated cluster", async () => {
      await cli.run(["cluster", "create", cluster, "--region", region]);
    });

    await step("deploy the idle worker (bootstraps edge-1 + one generated-name app node)", async () => {
      await cli.run(["deploy", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S], { cwd: dir });
      const edge = await cli.json<NodeShow>(["node", "show", edgeNode, "--cluster", cluster]);
      assertEquals(edge.node.role, "edge", "the first deploy bootstrapped the cluster edge");
      const appNodes = await listAppNodeIds(cli, cluster);
      assertEquals(appNodes.length, 1, `exactly one app node bootstrapped (${appNodes.join(", ")})`);
      node1 = appNodes[0]!;
      const running = await retry(() => runningOn(cli, node1, cluster, service), {
        tries: 18,
        delayMs: 10_000,
        until: (n) => n === 1,
      });
      assertEquals(running, 1, `worker runs 1 replica on ${node1}`);
    });

    await step("save the scale-out policy (min 1, max 2, out ≥25%, in <10%)", async () => {
      await cli.run(
        autoscaleArgs(["set", "--min", "1", "--max", "2", "--scale-out-percent", "25", "--scale-in-percent", "10", "--cooldown", "0"]),
      );
      const shown = await cli.json<{ autoscale: { minNodes: number; maxNodes: number } }>(autoscaleArgs(["show"]));
      assertEquals(shown.autoscale.minNodes, 1, "policy persisted minNodes=1 in cluster.json");
      assertEquals(shown.autoscale.maxNodes, 2, "policy persisted maxNodes=2 in cluster.json");
    });

    await step("autoscale run is a no-op once the boot churn settles", async () => {
      // The first host sample lands mid-boot (cloud-init/docker churn can exceed 50%
      // CPU), so poll the DRY RUN until a calm sample arrives before asserting.
      const planned = await retry(
        () => cli.json<AutoscaleResult>(autoscaleArgs(["run", "--dry-run"]), { cwd: dir }),
        { tries: 24, delayMs: 15_000, until: (r) => r.action === "none" },
      );
      assertEquals(planned.action, "none", `idle pool plans no action (${planned.reason ?? ""})`);
      const out = await cli.json<AutoscaleResult>(autoscaleArgs(["run", "--yes"]), { cwd: dir });
      assertEquals(out.action, "none", `a real run is also a no-op (${out.reason ?? ""})`);
    });

    await step("BURN=1 rolls the worker into a memory hog (config set — lock permits env)", async () => {
      await cli.run(
        ["config", "set", service, "BURN=1", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: dir },
      );
    });

    await step("hot pool: dry-run plans a scale-out once a fresh sample crosses 25%", async () => {
      const planned = await retry(
        () => cli.json<AutoscaleResult>(autoscaleArgs(["run", "--dry-run"]), { cwd: dir }),
        { tries: 24, delayMs: 15_000, until: (r) => r.action === "scale-out" },
      );
      assertEquals(planned.action, "scale-out", `planner saw the memory pressure (${planned.reason ?? ""})`);
    });

    await step("autoscale run provisions a second app node behind the cluster edge", async () => {
      const out = await cli.json<AutoscaleResult>(autoscaleArgs(["run", "--yes"]), { cwd: dir });
      assertEquals(out.action, "scale-out", "run applied the scale-out");
      assert(typeof out.node === "string" && out.node !== node1 && out.node !== edgeNode, `the new node has a fresh generated name (${out.node})`);
      node2 = out.node!;
      const show = await cli.json<NodeShow>(["node", "show", node2, "--cluster", cluster]);
      assertEquals(show.node.role, "app", "scale-out created an app node (never an edge)");
    });

    await step("a second run refuses to scale past maxNodes", async () => {
      const out = await cli.json<AutoscaleResult>(autoscaleArgs(["run", "--yes"]), { cwd: dir });
      assertEquals(out.action, "none", `at maxNodes the planner holds (${out.reason ?? ""})`);
    });

    await step("BURN=0 + scale replicas 2 spreads 1+1 (the new node serves workloads)", async () => {
      await cli.run(
        ["config", "set", service, "BURN=0", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: dir },
      );
      await cli.run(
        ["scale", "replicas", service, "2", "--cluster", cluster, "--yes", "--timeout", DEPLOY_TIMEOUT_S],
        { cwd: dir },
      );
      const onNode2 = await retry(() => runningOn(cli, node2, cluster, service), {
        tries: 24,
        delayMs: 10_000,
        until: (n) => n === 1,
      });
      assertEquals(onNode2, 1, `one replica runs on the auto-added ${node2}`);
      assertEquals(await runningOn(cli, node1, cluster, service), 1, `one replica stays on ${node1}`);
    });

    await step("save the scale-in policy (out ≥90%, in <60%)", async () => {
      await cli.run(
        autoscaleArgs(["set", "--min", "1", "--max", "2", "--scale-out-percent", "90", "--scale-in-percent", "60", "--cooldown", "0"]),
      );
    });

    let victim = "";
    let survivor = "";
    await step("cold pool: dry-run plans a scale-in of an app node (the edge is never a candidate)", async () => {
      const planned = await retry(
        () => cli.json<AutoscaleResult>(autoscaleArgs(["run", "--dry-run"]), { cwd: dir }),
        { tries: 24, delayMs: 15_000, until: (r) => r.action === "scale-in" },
      );
      assertEquals(planned.action, "scale-in", `planner saw the idle pool (${planned.reason ?? ""})`);
      // The cluster edge is never a scale-in candidate — the victim must be an app node.
      assert(planned.victim === node1 || planned.victim === node2, `the victim is an app node, never the edge (${planned.victim})`);
      victim = planned.victim!;
      survivor = victim === node1 ? node2 : node1;
      note(`victim ${victim} · survivor ${survivor}`);
    });

    await step("autoscale run drains the victim (replica moves first) and terminates it", async () => {
      const out = await cli.json<AutoscaleResult>(autoscaleArgs(["run", "--yes"]), { cwd: dir });
      assertEquals(out.action, "scale-in", "run applied the scale-in");
      assertEquals(out.node, victim, `the drained node is ${victim}`);
      assert(!(await nodeExists(cli, victim, cluster)), `${victim} is gone from the cluster`);
      // The drain waited for convergence BEFORE teardown, so both replicas live on the survivor.
      const onSurvivor = await retry(() => runningOn(cli, survivor, cluster, service), {
        tries: 12,
        delayMs: 10_000,
        until: (n) => n === 2,
      });
      assertEquals(onSurvivor, 2, "both replicas run on the surviving app node after the evacuation");
    });

    await step("a final run holds the pool at minNodes", async () => {
      const out = await cli.json<AutoscaleResult>(autoscaleArgs(["run", "--yes"]), { cwd: dir });
      assertEquals(out.action, "none", `at minNodes the planner holds (${out.reason ?? ""})`);
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
    process.exitCode = printSummary() ? 1 : 1;
  });
