import {
  DEFAULT_POLL_INTERVAL_MS,
  LIVENESS_HEARTBEAT_MS,
  type NodeRegistryEntry,
  type NodeRole,
} from "@agentsystemlabs/launch-pad-shared";
import { color } from "../ui/theme";

/** AWS bills a standard month as 730 on-demand hours. */
export const HOURS_PER_MONTH = 730;

/** S3 Standard request pricing (us-east-1 baseline; other regions vary slightly). */
export const S3_GET_PER_1K_REQUESTS_USD = 0.0004;
export const S3_PUT_PER_1K_REQUESTS_USD = 0.005;

/**
 * On-demand Linux hourly rates (us-east-1, approximate). Unknown types return null
 * so the UI can say "lookup required" instead of guessing.
 */
export const INSTANCE_HOURLY_USD: Record<string, number> = {
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "t3a.micro": 0.0094,
  "t3a.small": 0.0188,
  "t3a.medium": 0.0376,
  "t3a.large": 0.0752,
  "t2.micro": 0.0116,
  "t2.small": 0.023,
  "t2.medium": 0.0464,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
};

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

export interface AgentS3Estimate {
  getObjectsPerMonth: number;
  putObjectsPerMonth: number;
  getCostUsd: number;
  putCostUsd: number;
  totalUsd: number;
}

export interface NodeCostInput {
  nodeId: string;
  role: NodeRole;
  instanceType: string;
  /** When false, skip EC2 (e.g. a sync-only drift repair). Agent S3 still applies. */
  billsEc2?: boolean;
}

export interface Ec2LineItem {
  instanceType: string;
  count: number;
  hourlyUsd: number | null;
  monthlyUsd: number | null;
}

export interface ProvisionCostEstimate {
  ec2Lines: Ec2LineItem[];
  ec2TotalUsd: number | null;
  s3ByNode: Array<{ nodeId: string; role: NodeRole; s3: AgentS3Estimate }>;
  s3GetObjectsPerMonth: number;
  s3PutObjectsPerMonth: number;
  s3GetTotalUsd: number;
  s3PutTotalUsd: number;
  s3TotalUsd: number;
  totalUsd: number | null;
}

function requestCost(count: number, per1k: number): number {
  return (count / 1000) * per1k;
}

function roundUsd(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function formatUsd(amount: number, opts?: { minFractionDigits?: number }): string {
  const min = opts?.minFractionDigits ?? 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: min,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function lookupHourlyUsd(instanceType: string): number | null {
  return INSTANCE_HOURLY_USD[instanceType] ?? null;
}

export function estimateEc2Monthly(instanceType: string, hours = HOURS_PER_MONTH): number | null {
  const hourly = lookupHourlyUsd(instanceType);
  if (hourly === null) return null;
  return roundUsd(hourly * hours);
}

/**
 * Steady-state agent S3 GetObject / PutObject volume for one node.
 *
 * Assumes default agent timing ({@link DEFAULT_POLL_INTERVAL_MS} poll,
 * {@link LIVENESS_HEARTBEAT_MS} status heartbeat). Each tick reads `desired.json`
 * on app/both nodes; status is PUT on first tick, on change, and on liveness.
 * Upstream shard GET/PUT are write-on-change and omitted here (negligible at rest).
 */
export function estimateAgentS3Monthly(
  role: NodeRole,
  opts?: { pollMs?: number; livenessMs?: number },
): AgentS3Estimate {
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
  const livenessMs = opts?.livenessMs ?? LIVENESS_HEARTBEAT_MS;

  const ticksPerMonth = MS_PER_MONTH / pollMs;
  const statusPutsPerMonth = MS_PER_MONTH / livenessMs;

  const getObjectsPerMonth = role === "edge" ? 0 : ticksPerMonth;
  const putObjectsPerMonth = statusPutsPerMonth;

  const getCostUsd = roundUsd(requestCost(getObjectsPerMonth, S3_GET_PER_1K_REQUESTS_USD));
  const putCostUsd = roundUsd(requestCost(putObjectsPerMonth, S3_PUT_PER_1K_REQUESTS_USD));

  return {
    getObjectsPerMonth: Math.round(getObjectsPerMonth),
    putObjectsPerMonth: Math.round(putObjectsPerMonth),
    getCostUsd,
    putCostUsd,
    totalUsd: roundUsd(getCostUsd + putCostUsd),
  };
}

export function estimateProvisionCost(nodes: NodeCostInput[]): ProvisionCostEstimate {
  const ec2Counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.billsEc2 === false) continue;
    ec2Counts.set(n.instanceType, (ec2Counts.get(n.instanceType) ?? 0) + 1);
  }

  const ec2Lines: Ec2LineItem[] = [...ec2Counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([instanceType, count]) => {
      const hourlyUsd = lookupHourlyUsd(instanceType);
      const monthlyUsd = hourlyUsd === null ? null : roundUsd(hourlyUsd * HOURS_PER_MONTH * count);
      return { instanceType, count, hourlyUsd, monthlyUsd };
    });

  let ec2TotalUsd: number | null = 0;
  for (const line of ec2Lines) {
    if (line.monthlyUsd === null) {
      ec2TotalUsd = null;
      break;
    }
    ec2TotalUsd += line.monthlyUsd;
  }
  if (ec2TotalUsd !== null) ec2TotalUsd = roundUsd(ec2TotalUsd);

  const s3ByNode = nodes.map((n) => ({
    nodeId: n.nodeId,
    role: n.role,
    s3: estimateAgentS3Monthly(n.role),
  }));

  const s3GetObjectsPerMonth = s3ByNode.reduce((sum, n) => sum + n.s3.getObjectsPerMonth, 0);
  const s3PutObjectsPerMonth = s3ByNode.reduce((sum, n) => sum + n.s3.putObjectsPerMonth, 0);
  const s3GetTotalUsd = roundUsd(
    s3ByNode.reduce((sum, n) => sum + n.s3.getCostUsd, 0),
  );
  const s3PutTotalUsd = roundUsd(
    s3ByNode.reduce((sum, n) => sum + n.s3.putCostUsd, 0),
  );
  const s3TotalUsd = roundUsd(s3GetTotalUsd + s3PutTotalUsd);

  let totalUsd: number | null;
  if (ec2TotalUsd === null) {
    totalUsd = null;
  } else {
    totalUsd = roundUsd(ec2TotalUsd + s3TotalUsd);
  }

  return {
    ec2Lines,
    ec2TotalUsd,
    s3ByNode,
    s3GetObjectsPerMonth,
    s3PutObjectsPerMonth,
    s3GetTotalUsd,
    s3PutTotalUsd,
    s3TotalUsd,
    totalUsd,
  };
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Panel lines for the provisioning cost breakdown. */
export function formatProvisionCostLines(
  estimate: ProvisionCostEstimate,
  region: string,
): string[] {
  const lines: string[] = [
    color.dim(
      `On-demand Linux baseline (${region}) · ${HOURS_PER_MONTH} h/mo · agent poll ${DEFAULT_POLL_INTERVAL_MS / 1000}s · heartbeat ${LIVENESS_HEARTBEAT_MS / 1000}s`,
    ),
  ];

  if (estimate.ec2Lines.length > 0) {
    lines.push(color.bold("EC2 compute"));
    for (const line of estimate.ec2Lines) {
      if (line.monthlyUsd === null || line.hourlyUsd === null) {
        lines.push(
          `  ${line.count} × ${line.instanceType}  ${color.dim("(hourly rate unknown — check AWS pricing)")}`,
        );
      } else {
        const each = roundUsd(line.hourlyUsd * HOURS_PER_MONTH);
        lines.push(
          `  ${line.count} × ${line.instanceType} @ ${formatUsd(each)}/mo each  ${color.dim("→")} ${formatUsd(line.monthlyUsd)}/mo`,
        );
      }
    }
    if (estimate.ec2TotalUsd !== null) {
      lines.push(`  ${color.dim("subtotal")}  ${formatUsd(estimate.ec2TotalUsd)}/mo`);
    }
  }

  if (estimate.s3ByNode.length > 0) {
    lines.push(color.bold("S3 agent polling (steady state)"));
    for (const { nodeId, role, s3 } of estimate.s3ByNode) {
      lines.push(`  ${nodeId} (${role})`);
      lines.push(
        `    GetObject  ${formatCount(s3.getObjectsPerMonth)}/mo  ${color.dim("→")} ${formatUsd(s3.getCostUsd, { minFractionDigits: 2 })}/mo`,
      );
      lines.push(
        `    PutObject  ${formatCount(s3.putObjectsPerMonth)}/mo  ${color.dim("→")} ${formatUsd(s3.putCostUsd, { minFractionDigits: 2 })}/mo`,
      );
    }
    lines.push(
      `  ${color.dim("GetObject total")}  ${formatCount(estimate.s3GetObjectsPerMonth)}/mo  ${color.dim("→")} ${formatUsd(estimate.s3GetTotalUsd)}/mo`,
    );
    lines.push(
      `  ${color.dim("PutObject total")}  ${formatCount(estimate.s3PutObjectsPerMonth)}/mo  ${color.dim("→")} ${formatUsd(estimate.s3PutTotalUsd)}/mo`,
    );
    lines.push(`  ${color.dim("S3 subtotal")}  ${formatUsd(estimate.s3TotalUsd)}/mo`);
  }

  if (estimate.totalUsd !== null) {
    lines.push(color.bold(`Estimated total  ${formatUsd(estimate.totalUsd)}/mo`));
  } else {
    lines.push(color.bold("Estimated total  unknown (EC2 rate missing for one or more types)"));
  }

  lines.push(
    color.dim(
      "Excludes gp3 root volume (~$0.08/GB-mo), data transfer, ECR storage, CloudWatch, and deploy-time S3 calls.",
    ),
  );

  return lines;
}

export interface ClusterCostSummary {
  /** EC2 + S3 estimate for the running nodes. */
  estimate: ProvisionCostEstimate;
  /** Nodes billing right now (ready / provisioning). */
  runningNodes: number;
  /** Stopped nodes — no compute/agent charge, but they still incur EBS + EIP (not estimated). */
  pausedNodes: number;
}

/**
 * Roll up a cluster's *ongoing* monthly cost from its registry. Running nodes
 * (ready/provisioning) bill EC2 + agent S3; stopped nodes are counted separately (their
 * agent is off and compute isn't charged, but their EBS volume + Elastic IP still cost — not
 * estimated here, same as the provision-time estimate); terminated/terminating are excluded.
 */
export function summarizeClusterCost(entries: NodeRegistryEntry[]): ClusterCostSummary {
  const running = entries.filter((e) => e.state === "ready" || e.state === "provisioning");
  const paused = entries.filter((e) => e.state === "stopped");
  const inputs: NodeCostInput[] = running.map((e) => ({
    nodeId: e.nodeId,
    role: e.role,
    instanceType: e.instanceType,
  }));
  return { estimate: estimateProvisionCost(inputs), runningNodes: running.length, pausedNodes: paused.length };
}

export interface BudgetVerdict {
  budgetUsd: number;
  /** The estimated monthly total, or null when an EC2 rate is unknown. */
  totalUsd: number | null;
  over: boolean;
  /** USD over budget (0 when within budget or unknown). */
  overByUsd: number;
}

/** Compare an estimated monthly total to a budget. An unknown total never reads as over. */
export function budgetVerdict(totalUsd: number | null, budgetUsd: number): BudgetVerdict {
  if (totalUsd === null) return { budgetUsd, totalUsd, over: false, overByUsd: 0 };
  const over = totalUsd > budgetUsd;
  return { budgetUsd, totalUsd, over, overByUsd: over ? roundUsd(totalUsd - budgetUsd) : 0 };
}

/** Per-node monthly estimate for a provisioning plan line (EC2 when billing + agent S3). */
export function formatNodeMonthlyCost(input: NodeCostInput): string {
  const s3 = estimateAgentS3Monthly(input.role);
  if (input.billsEc2 === false) {
    return color.dim(`· ~${formatUsd(s3.totalUsd)}/mo`);
  }
  const ec2 = estimateEc2Monthly(input.instanceType);
  if (ec2 === null) {
    return color.dim("· cost unknown");
  }
  return color.dim(`· ~${formatUsd(ec2 + s3.totalUsd)}/mo`);
}

/** Short summary for a yes/no confirmation prompt. */
export function formatProvisionCostSummary(estimate: ProvisionCostEstimate): string {
  if (estimate.totalUsd === null) {
    return "estimated cost unknown for one or more instance types";
  }
  const parts: string[] = [`~${formatUsd(estimate.totalUsd)}/mo`];
  if (estimate.ec2TotalUsd !== null && estimate.ec2TotalUsd > 0) {
    parts.push(`EC2 ${formatUsd(estimate.ec2TotalUsd)}`);
  }
  if (estimate.s3TotalUsd > 0) {
    parts.push(`S3 agent ${formatUsd(estimate.s3TotalUsd)} (Get ${formatUsd(estimate.s3GetTotalUsd)} + Put ${formatUsd(estimate.s3PutTotalUsd)})`);
  }
  return parts.join(" · ");
}
