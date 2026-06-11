/**
 * launch-pad real-AWS regression for `launch-pad cost`'s idle-node recommendations.
 *
 * Fast (one node, no deploy/Docker): provision a single `both` node, then assert the cost
 * report flags it correctly across its lifecycle:
 *   - while provisioning → never flagged (not yet idle),
 *   - after `node pause` → flagged `paused` (still paying for EBS + Elastic IP),
 *   - with a high --idle-days threshold → not flagged (within the window).
 * Then destroy.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:idle   (`--keep` skips teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCli } from "./cli";
import { assert, assertEquals, note, printSummary, step } from "./report";

interface IdleRec {
  nodeId: string;
  role: string;
  kind: "paused" | "empty";
  idleDays: number;
  monthlyWasteUsd: number | null;
}
interface CostJson {
  cluster: string;
  runningNodes: number;
  pausedNodes: number;
  idle: { minIdleDays: number; recommendations: IdleRec[] };
}
interface DestroyJson {
  destroyed: string[];
  warnings: string[];
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS idle-recommendations e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:idle\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-idle-${runId}`;
  const node = "idle-both";

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });

  note(`run ${runId} · cluster ${cluster} · region ${region} · idle recs (one node, no deploy)`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the cluster + clean up state", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      assert(
        out.warnings.length === 0,
        `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`,
      );
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
    await step("create a cluster + provision one both node", async () => {
      await cli.run(["cluster", "create", cluster, "--region", region]);
      await cli.run(["node", "create", node, "--role", "both", "--cluster", cluster, "--yes"]);
    });

    await step("a just-provisioned node is not flagged idle (mid-setup, not wasting yet)", async () => {
      const out = await cli.json<CostJson>(["cost", "--cluster", cluster, "--idle-days", "0"]);
      assertEquals(out.runningNodes, 1, "cost sees 1 running node");
      assertEquals(out.pausedNodes, 0, "no paused nodes yet");
      assertEquals(out.idle.recommendations.length, 0, "a provisioning node yields no idle recs");
    });

    await step("node pause stops the instance", async () => {
      await cli.run(["node", "pause", node, "--cluster", cluster]);
    });

    await step("a paused node is flagged idle (EBS + Elastic IP still billing)", async () => {
      const out = await cli.json<CostJson>(["cost", "--cluster", cluster, "--idle-days", "0"]);
      assertEquals(out.runningNodes, 0, "no running nodes after pause");
      assertEquals(out.pausedNodes, 1, "1 paused node after pause");
      assertEquals(out.idle.recommendations.length, 1, "exactly one idle recommendation");
      const rec = out.idle.recommendations[0]!;
      assertEquals(rec.nodeId, node, "the recommendation names the paused node");
      assertEquals(rec.kind, "paused", "classified as a paused idle node");
      assertEquals(rec.monthlyWasteUsd, null, "paused compute isn't dollar-estimated (only EBS+EIP)");
      note(`flagged ${rec.nodeId} paused ${rec.idleDays}d`);
    });

    await step("a high --idle-days threshold gates the just-paused node out", async () => {
      const out = await cli.json<CostJson>(["cost", "--cluster", cluster, "--idle-days", "365"]);
      assertEquals(out.idle.minIdleDays, 365, "threshold echoed back");
      assertEquals(
        out.idle.recommendations.length,
        0,
        "a node paused seconds ago is within a 365-day window",
      );
    });
  } finally {
    if (keep) {
      note(`--keep set — leaving cluster "${cluster}" running. Tear it down later with:`);
      note(`  LAUNCHPAD_HOME=${home} launch-pad cluster destroy ${cluster} --yes`);
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
