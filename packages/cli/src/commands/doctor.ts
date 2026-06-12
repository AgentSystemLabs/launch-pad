import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { Command } from "commander";
import { nodeRegistryKey, parseNodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { awsErrorName, awsStatusCode } from "../aws/errors";
import { getEcrAuth } from "../aws/ecr";
import { getDefaultVpcId } from "../aws/ec2";
import { getJson, listNodeIds } from "../aws/s3-state";
import { checkDocker } from "../deploy/build";
import { type Check, overallOk, summarize } from "../doctor/report";
import { resolveNodeAmi } from "../provision/golden-ami";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { color, symbols } from "../ui/theme";

type DoctorOptions = GlobalOpts;

const AWS_DEPENDENT_CHECKS = [
  "S3 state bucket",
  "ECR access",
  "default VPC",
  "golden AMIs",
  "agent runtime",
] as const;

function fromError(name: string, error: unknown, hint: string): Check {
  return { name, status: "fail", detail: (error as Error).message, hint };
}

async function checkDockerHealth(): Promise<Check> {
  const name = "Docker + buildx";
  try {
    await checkDocker();
    return { name, status: "pass", detail: "docker daemon + buildx available" };
  } catch (error) {
    return fromError(name, error, "install Docker Desktop (or docker + buildx) and start the daemon");
  }
}

async function checkStateBucket(aws: AwsEnv): Promise<Check> {
  const name = "S3 state bucket";
  try {
    await aws.s3.send(new HeadBucketCommand({ Bucket: aws.bucket }));
    return { name, status: "pass", detail: `${aws.bucket} reachable` };
  } catch (error) {
    if (awsStatusCode(error) === 404 || awsErrorName(error) === "NotFound") {
      return {
        name,
        status: "warn",
        detail: `${aws.bucket} does not exist yet`,
        hint: "it's created automatically on your first deploy",
      };
    }
    return {
      name,
      status: "fail",
      detail: `${aws.bucket} not accessible (${(error as Error).message})`,
      hint: "your IAM principal needs s3:* on the state bucket (or it's owned by another account)",
    };
  }
}

async function checkEcr(aws: AwsEnv): Promise<Check> {
  const name = "ECR access";
  try {
    await getEcrAuth(aws.ecr);
    return { name, status: "pass", detail: "authorization token obtained" };
  } catch (error) {
    return fromError(name, error, "your IAM principal needs ecr:GetAuthorizationToken + repo push/pull");
  }
}

async function checkDefaultVpc(aws: AwsEnv): Promise<Check> {
  const name = "default VPC";
  try {
    const id = await getDefaultVpcId(aws.ec2);
    return { name, status: "pass", detail: `${id} in ${aws.region}` };
  } catch (error) {
    return fromError(name, error, "create a default VPC in this region (custom networking isn't supported yet)");
  }
}

async function checkGoldenAmi(aws: AwsEnv): Promise<Check> {
  const name = "golden AMIs";
  try {
    const base = { ec2: aws.ec2, ssm: aws.ssm, region: aws.region };
    const [edge, app] = await Promise.all([
      resolveNodeAmi({ ...base, role: "edge" }),
      resolveNodeAmi({ ...base, role: "app" }),
    ]);
    if (edge.bootstrapMode === "golden" && app.bootstrapMode === "golden") {
      return { name, status: "pass", detail: `edge ${edge.imageId}, app ${app.imageId}` };
    }
    const missing = [
      ...(edge.bootstrapMode === "golden" ? [] : ["edge"]),
      ...(app.bootstrapMode === "golden" ? [] : ["app"]),
    ].join(" + ");
    return {
      name,
      status: "warn",
      detail: `no ${missing} golden AMI for ${aws.region}; those nodes full-bootstrap AL2023`,
      hint: "first boot is slower — build the golden AMIs (scripts/build-golden-ami.sh) for faster provisioning",
    };
  } catch (error) {
    return fromError(name, error, "couldn't resolve any AMI — check ec2:DescribeImages + SSM read access");
  }
}

/**
 * Warn while any node in the target cluster still runs the deprecated TypeScript
 * agent — the Rust binaries are canonical and `node upgrade-agent` migrates a live
 * node in place (no re-provision).
 */
async function checkLegacyAgents(aws: AwsEnv): Promise<Check> {
  const name = "agent runtime";
  try {
    const ids = await listNodeIds(aws.s3, aws.bucket, aws.clusterId);
    if (ids.length === 0) return { name, status: "skip", detail: "no nodes yet" };
    const legacy: string[] = [];
    for (const id of ids) {
      const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
      if (!obj) continue;
      try {
        if (parseNodeRegistryEntry(obj.raw).agentType === "ts") legacy.push(id);
      } catch {
        /* unparseable entries surface through other commands */
      }
    }
    if (legacy.length === 0) {
      return { name, status: "pass", detail: `all ${ids.length} node(s) run the rust agent` };
    }
    return {
      name,
      status: "warn",
      detail: `node(s) ${legacy.join(", ")} still run the deprecated TypeScript agent`,
      hint: "migrate in place (no re-provision): launchpad node upgrade-agent --yes",
    };
  } catch (error) {
    return fromError(name, error, "couldn't read the node registry");
  }
}

const STATUS_SYMBOL: Record<Check["status"], string> = {
  pass: color.green(symbols.success),
  warn: color.yellow(symbols.warn),
  fail: color.red(symbols.error),
  skip: color.dim("–"),
};

function report(checks: Check[]): void {
  const ok = overallOk(checks);
  const s = summarize(checks);

  if (isJsonMode()) {
    printJson({ ok, summary: s, checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${STATUS_SYMBOL[c.status]} ${color.bold(c.name)} ${color.dim("·")} ${c.detail}`);
    if (c.hint && (c.status === "fail" || c.status === "warn")) {
      lines.push(`   ${color.dim(`${symbols.arrow} ${c.hint}`)}`);
    }
  }
  panel("Preflight", lines);

  const tail =
    `${s.pass} ok` +
    (s.warn ? `, ${s.warn} warn` : "") +
    (s.fail ? `, ${s.fail} fail` : "") +
    (s.skip ? `, ${s.skip} skipped` : "");
  if (ok) {
    log.success(`preflight passed (${tail})`);
  } else {
    log.error(`preflight found blockers (${tail})`);
    process.exitCode = 1;
  }
}

async function runDoctor(opts: DoctorOptions): Promise<void> {
  const checks: Check[] = [];

  // Docker is purely local — check it first, independent of AWS.
  const spin = isJsonMode() ? null : spinner("running preflight checks…").start();
  checks.push(await checkDockerHealth());

  // Resolving AWS identity also validates creds + region; if it fails, the
  // downstream AWS checks can't run, so record the failure and skip them rather
  // than aborting the whole command.
  let aws: AwsEnv | null = null;
  try {
    aws = await prepareAws(opts);
    checks.push({
      name: "AWS credentials & region",
      status: "pass",
      detail: `account ${aws.accountId} · ${aws.region} · ${aws.callerArn}`,
    });
  } catch (error) {
    checks.push(
      fromError(
        "AWS credentials & region",
        error,
        "set credentials + a region (aws configure, AWS_PROFILE, or --profile/--region)",
      ),
    );
  }

  if (aws) {
    checks.push(await checkStateBucket(aws));
    checks.push(await checkEcr(aws));
    checks.push(await checkDefaultVpc(aws));
    checks.push(await checkGoldenAmi(aws));
    checks.push(await checkLegacyAgents(aws));
  } else {
    for (const name of AWS_DEPENDENT_CHECKS) {
      checks.push({ name, status: "skip", detail: "skipped — fix AWS credentials first" });
    }
  }

  spin?.stop();
  report(checks);
}

export function registerDoctor(program: Command): void {
  const cmd = program
    .command("doctor")
    .description("Preflight your environment before first deploy (Docker, AWS creds, S3, ECR, VPC, AMI)")
    .addHelpText(
      "after",
      [
        "",
        "Runs read-only checks and reports pass / warn / fail for each — it provisions",
        "nothing and spends nothing. Exit code is non-zero if any check fails, so it's",
        "safe to gate a CI pipeline on `launchpad doctor`.",
        "",
        "Examples:",
        "  $ launchpad doctor",
        "  $ launchpad doctor --region us-west-2 --json",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runDoctor(mergedOpts<DoctorOptions>(command));
    });

  applyGlobalOptions(cmd);
}
