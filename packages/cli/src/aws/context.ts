import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { EC2Client } from "@aws-sdk/client-ec2";
import type { ECRClient } from "@aws-sdk/client-ecr";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SNSClient } from "@aws-sdk/client-sns";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { DEFAULT_CLUSTER, stateBucketName } from "@agentsystemlabs/launch-pad-shared";
import { assertValidClusterId, loadLocalConfig } from "../config/local";
import { CliError } from "../errors";
import type { GlobalOpts } from "../globals";
import { createClients } from "./clients";
import { rethrowAwsError } from "./errors";
import { ensureBucket } from "./s3-state";

export interface AwsEnv {
  /** The cluster this environment is scoped to (scopes S3 keys + the account/region). */
  clusterId: string;
  region: string;
  accountId: string;
  callerArn: string;
  bucket: string;
  s3: S3Client;
  ecr: ECRClient;
  sts: STSClient;
  ec2: EC2Client;
  iam: IAMClient;
  ssm: SSMClient;
  logs: CloudWatchLogsClient;
  sns: SNSClient;
  sqs: SQSClient;
}

export async function getCallerIdentity(
  sts: STSClient,
): Promise<{ accountId: string; arn: string }> {
  let res;
  try {
    res = await sts.send(new GetCallerIdentityCommand({}));
  } catch (error) {
    rethrowAwsError(error, "resolving your AWS identity");
  }
  if (!res.Account) {
    throw new CliError("could not resolve your AWS account id", {
      hint: "check that your AWS credentials are valid",
    });
  }
  return { accountId: res.Account, arn: res.Arn ?? "unknown" };
}

/**
 * Resolve the target cluster (`--cluster` → local `defaultCluster` → "default"),
 * then build clients + identity + the account/region-scoped state bucket for it.
 * The cluster's local target supplies a region/profile when set; an explicit
 * `--region`/`--profile` flag still wins. Pass `{ ensureBucket: true }` for
 * commands that will write state, so the bucket is created on first use.
 */
export async function prepareAws(
  opts: GlobalOpts,
  options: { ensureBucket?: boolean } = {},
): Promise<AwsEnv> {
  const local = loadLocalConfig();
  const clusterId = opts.cluster ?? local.defaultCluster ?? DEFAULT_CLUSTER;
  assertValidClusterId(clusterId);
  const target = local.clusters[clusterId];

  if (target?.roleArn) {
    throw new CliError(`cluster "${clusterId}" uses a cross-account roleArn, which isn't supported yet`, {
      hint: "cross-account clusters land in Phase 2 — use a `profile` target for now",
    });
  }

  const resolvedOpts: GlobalOpts = {
    ...opts,
    region: opts.region ?? target?.region,
    profile: opts.profile ?? target?.profile,
  };

  const { region, s3, ecr, sts, ec2, iam, ssm, logs, sns, sqs } = await createClients(resolvedOpts);
  const { accountId, arn } = await getCallerIdentity(sts);
  const bucket = stateBucketName(accountId, region);
  if (options.ensureBucket) {
    await ensureBucket(s3, bucket, region, clusterId);
  }
  return { clusterId, region, accountId, callerArn: arn, bucket, s3, ecr, sts, ec2, iam, ssm, logs, sns, sqs };
}
