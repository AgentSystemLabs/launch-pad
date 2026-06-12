/**
 * launchpad real-AWS regression for `launchpad cost` — ongoing monthly cost rollup
 * + the `--budget` gate.
 *
 * Fast (one node, no deploy/Docker): provision a single edge node, then assert `cost`
 * reports it with a positive EC2 estimate, that `--budget 0` flags over-budget (non-zero
 * exit), and `--budget 10000` is within budget. Then destroy.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:cost   (`--keep` skips teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCli } from "./cli";
import { assert, assertEquals, note, printSummary, step } from "./report";

interface CostJson {
  cluster: string;
  runningNodes: number;
  pausedNodes: number;
  estimate: {
    ec2Lines: Array<{ instanceType: string; count: number; monthlyUsd: number | null }>;
    ec2TotalUsd: number | null;
    totalUsd: number | null;
  };
  budget: { budgetUsd: number; totalUsd: number | null; over: boolean; overByUsd: number } | null;
}
interface DestroyJson {
  destroyed: string[];
  warnings: string[];
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS cost e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:cost\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-cost-${runId}`;
  const node = "cost-edge";

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });

  note(`run ${runId} · cluster ${cluster} · region ${region} · cost (one node, no deploy)`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the cluster + clean up state", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      assert(out.warnings.length === 0, `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`);
    }).catch(() => {
      /* recorded as a failed step; keep cleaning up */
    });
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    await step("create a cluster + provision one edge node", async () => {
      await cli.run(["cluster", "create", cluster, "--region", region]);
      await cli.run(["node", "create", node, "--role", "edge", "--cluster", cluster, "--yes"]);
    });

    await step("cost reports the running node with a positive EC2 estimate", async () => {
      const out = await cli.json<CostJson>(["cost", "--cluster", cluster]);
      assertEquals(out.runningNodes, 1, "cost sees 1 running node");
      assertEquals(out.pausedNodes, 0, "no paused nodes");
      assert(out.estimate.ec2Lines.length >= 1, "cost lists at least one EC2 line item");
      assert((out.estimate.ec2TotalUsd ?? 0) > 0, `EC2 estimate is positive (${out.estimate.ec2TotalUsd})`);
      assert((out.estimate.totalUsd ?? 0) > 0, `monthly total is positive (${out.estimate.totalUsd})`);
      note(`estimate: $${out.estimate.totalUsd}/mo`);
    });

    await step("--budget 0 flags over-budget and exits non-zero", async () => {
      const res = await cli.run(["cost", "--cluster", cluster, "--budget", "0", "--json"], { allowFail: true });
      assert(res.exitCode !== 0, `cost --budget 0 exits non-zero (exit ${res.exitCode})`);
      const out = JSON.parse(res.stdout) as CostJson;
      assert(out.budget?.over === true, "the budget verdict is over");
      assert((out.budget?.overByUsd ?? 0) > 0, "the overage is positive");
    });

    await step("--budget 10000 is within budget (exit 0)", async () => {
      const out = await cli.json<CostJson>(["cost", "--cluster", cluster, "--budget", "10000"]);
      assert(out.budget?.over === false, "the budget verdict is within budget");
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
