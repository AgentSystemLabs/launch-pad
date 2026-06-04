import type { EC2Client } from "@aws-sdk/client-ec2";
import type { ECRClient } from "@aws-sdk/client-ecr";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, type STSClient } from "@aws-sdk/client-sts";
import { stateBucketName } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";
import type { GlobalOpts } from "../globals";
import { createClients } from "./clients";
import { rethrowAwsError } from "./errors";
import { ensureBucket } from "./s3-state";

export interface AwsEnv {
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
 * Resolve clients + identity + the account/region-scoped state bucket name. Pass
 * `{ ensureBucket: true }` for commands that will write state, so the bucket is
 * created on first use.
 */
export async function prepareAws(
  opts: GlobalOpts,
  options: { ensureBucket?: boolean } = {},
): Promise<AwsEnv> {
  const { region, s3, ecr, sts, ec2, iam, ssm } = await createClients(opts);
  const { accountId, arn } = await getCallerIdentity(sts);
  const bucket = stateBucketName(accountId, region);
  if (options.ensureBucket) {
    await ensureBucket(s3, bucket, region);
  }
  return { region, accountId, callerArn: arn, bucket, s3, ecr, sts, ec2, iam, ssm };
}
