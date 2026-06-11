import { Command } from "commander";
import {
  desiredKey,
  type NodeRegistryEntry,
  nodeRegistryKey,
  parseDesiredState,
  parseNodeRegistryEntry,
  parseNodeStatus,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import {
  budgetVerdict,
  formatProvisionCostLines,
  formatUsd,
  summarizeClusterCost,
} from "../cost/estimate";
import {
  DEFAULT_MIN_IDLE_DAYS,
  type IdleNodeInput,
  type IdleRecommendation,
  recommendIdleNodes,
} from "../cost/idle";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface CostOptions extends GlobalOpts {
  /** Monthly USD budget; exit non-zero + warn when the estimate exceeds it. */
  budget?: string;
  /** Age (days) before an idle node is flagged in the recommendations section. */
  idleDays?: string;
}

function parseBudget(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(`invalid --budget "${raw}"`, { hint: "pass a non-negative dollar amount, e.g. --budget 50" });
  }
  return n;
}

function parseIdleDays(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`invalid --idle-days "${raw}"`, { hint: "pass a non-negative whole number of days, e.g. --idle-days 7" });
  }
  return n;
}

/** Project a registry entry plus its (optional) status/desired docs to an idle signal. */
async function idleInputForNode(
  aws: Awaited<ReturnType<typeof prepareAws>>,
  entry: NodeRegistryEntry,
): Promise<IdleNodeInput> {
  let lastSeen: string | null = null;
  let edgeRoutes: number | null = null;
  let desiredServices = 0;

  const statusObj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, entry.nodeId));
  if (statusObj) {
    try {
      const status = parseNodeStatus(statusObj.raw);
      lastSeen = status.lastSeen;
      edgeRoutes = status.edgeRoutes.length;
    } catch {
      /* a malformed status.json shouldn't crash a cost report */
    }
  }

  const desiredObj = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, entry.nodeId));
  if (desiredObj) {
    try {
      desiredServices = parseDesiredState(desiredObj.raw).services.length;
    } catch {
      /* a malformed desired.json shouldn't crash a cost report */
    }
  }

  return {
    nodeId: entry.nodeId,
    role: entry.role,
    instanceType: entry.instanceType,
    state: entry.state,
    createdAt: entry.createdAt,
    lastSeen,
    desiredServices,
    edgeRoutes,
  };
}

/** Panel lines for the idle-node recommendations (empty when nothing's idle). */
function formatIdleLines(idle: IdleRecommendation[], minIdleDays: number): string[] {
  if (idle.length === 0) return [];
  const lines: string[] = [color.bold(`Idle nodes (≥ ${minIdleDays}d)`)];
  for (const rec of idle) {
    const waste =
      rec.monthlyWasteUsd !== null ? color.yellow(` · ~${formatUsd(rec.monthlyWasteUsd)}/mo wasted`) : "";
    lines.push(`  ${rec.nodeId} (${rec.role}) — ${rec.message}${waste}`);
    lines.push(`    ${color.dim(rec.hint)}`);
  }
  return lines;
}

async function runCost(opts: CostOptions): Promise<void> {
  const budget = opts.budget !== undefined ? parseBudget(opts.budget) : null;
  const minIdleDays = opts.idleDays !== undefined ? parseIdleDays(opts.idleDays) : DEFAULT_MIN_IDLE_DAYS;
  const aws = await prepareAws(opts);

  const entries = [];
  for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) {
    const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    if (obj) entries.push(parseNodeRegistryEntry(obj.raw));
  }

  const summary = summarizeClusterCost(entries);
  const verdict = budget !== null ? budgetVerdict(summary.estimate.totalUsd, budget) : null;

  const idleInputs: IdleNodeInput[] = [];
  for (const entry of entries) idleInputs.push(await idleInputForNode(aws, entry));
  const idle = recommendIdleNodes(idleInputs, Date.now(), { minIdleDays });

  if (isJsonMode()) {
    printJson({
      cluster: aws.clusterId,
      region: aws.region,
      runningNodes: summary.runningNodes,
      pausedNodes: summary.pausedNodes,
      estimate: summary.estimate,
      budget: verdict,
      idle: { minIdleDays, recommendations: idle },
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
  for (const line of formatIdleLines(idle, minIdleDays)) lines.push(line);
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
    .option(
      "--idle-days <n>",
      `flag idle nodes (paused, or running-but-empty) older than N days (default ${DEFAULT_MIN_IDLE_DAYS})`,
    )
    .addHelpText(
      "after",
      [
        "",
        "Rolls up the running nodes' on-demand EC2 + agent S3 polling into a monthly estimate.",
        "Paused nodes are noted separately (they still incur EBS + Elastic IP). Excludes data",
        "transfer, ECR/CloudWatch storage, and gp3 root volumes — it's a baseline, not a bill.",
        "",
        "It also flags idle nodes wasting money: a paused (stopped) node still paying for its",
        "EBS volume + Elastic IP, or a running node hosting no services (burning full EC2).",
        "Tune the age threshold with --idle-days (advisory — only --budget changes the exit code).",
        "",
        "With --budget, the command exits non-zero when the estimate is over — so you can gate",
        "it in CI / a scheduled check to catch a cluster that grew past its threshold.",
        "",
        "Examples:",
        "  $ launch-pad cost",
        "  $ launch-pad cost --cluster prod --budget 100",
        "  $ launch-pad cost --idle-days 3",
        "  $ launch-pad cost --json --budget 100",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runCost(mergedOpts<CostOptions>(command));
    });
  applyGlobalOptions(cost);
}
