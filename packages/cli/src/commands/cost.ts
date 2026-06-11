import { Command } from "commander";
import { nodeRegistryKey, parseNodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import {
  budgetVerdict,
  formatProvisionCostLines,
  formatUsd,
  summarizeClusterCost,
} from "../cost/estimate";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface CostOptions extends GlobalOpts {
  /** Monthly USD budget; exit non-zero + warn when the estimate exceeds it. */
  budget?: string;
}

function parseBudget(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(`invalid --budget "${raw}"`, { hint: "pass a non-negative dollar amount, e.g. --budget 50" });
  }
  return n;
}

async function runCost(opts: CostOptions): Promise<void> {
  const budget = opts.budget !== undefined ? parseBudget(opts.budget) : null;
  const aws = await prepareAws(opts);

  const entries = [];
  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (obj) entries.push(parseNodeRegistryEntry(obj.raw));
  }

  const summary = summarizeClusterCost(entries);
  const verdict = budget !== null ? budgetVerdict(summary.estimate.totalUsd, budget) : null;

  if (isJsonMode()) {
    printJson({
      cluster: aws.clusterId,
      region: aws.region,
      runningNodes: summary.runningNodes,
      pausedNodes: summary.pausedNodes,
      estimate: summary.estimate,
      budget: verdict,
    });
    if (verdict?.over) process.exitCode = 1;
    return;
  }

  if (summary.runningNodes === 0 && summary.pausedNodes === 0) {
    log.info(`cluster "${aws.clusterId}" has no nodes — nothing to estimate`);
    return;
  }

  const lines = formatProvisionCostLines(summary.estimate, aws.region);
  if (summary.pausedNodes > 0) {
    lines.push(
      color.dim(
        `${summary.pausedNodes} paused node(s) not estimated — stopped instances still incur EBS volume + Elastic IP charges.`,
      ),
    );
  }
  if (verdict !== null) {
    if (verdict.totalUsd === null) {
      lines.push(color.yellow(`budget ${formatUsd(verdict.budgetUsd)}/mo — can't compare (an EC2 rate is unknown)`));
    } else if (verdict.over) {
      lines.push(color.red(`OVER budget ${formatUsd(verdict.budgetUsd)}/mo by ${formatUsd(verdict.overByUsd)}/mo`));
    } else {
      lines.push(color.green(`within budget ${formatUsd(verdict.budgetUsd)}/mo`));
    }
  }
  panel(`Cost · ${aws.clusterId}`, lines);

  if (verdict?.over) process.exitCode = 1;
}

export function registerCost(program: Command): void {
  const cost = program
    .command("cost")
    .description("Estimate the cluster's ongoing monthly cost (EC2 + agent S3), with an optional budget gate")
    .option("--budget <usd>", "monthly USD budget; exit non-zero when the estimate exceeds it")
    .addHelpText(
      "after",
      [
        "",
        "Rolls up the running nodes' on-demand EC2 + agent S3 polling into a monthly estimate.",
        "Paused nodes are noted separately (they still incur EBS + Elastic IP). Excludes data",
        "transfer, ECR/CloudWatch storage, and gp3 root volumes — it's a baseline, not a bill.",
        "",
        "With --budget, the command exits non-zero when the estimate is over — so you can gate",
        "it in CI / a scheduled check to catch a cluster that grew past its threshold.",
        "",
        "Examples:",
        "  $ launch-pad cost",
        "  $ launch-pad cost --cluster prod --budget 100",
        "  $ launch-pad cost --json --budget 100",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runCost(mergedOpts<CostOptions>(command));
    });
  applyGlobalOptions(cost);
}
