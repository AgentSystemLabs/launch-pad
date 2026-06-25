import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client } from "@aws-sdk/client-ec2";
import { ECRClient } from "@aws-sdk/client-ecr";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { CliError } from "../errors";
import type { GlobalOpts } from "../globals";

export interface AwsClients {
  region: string;
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

/**
 * Build the AWS SDK clients, honoring `--profile` / `--region`. Region is resolved
 * from the flag, then the environment, then the shared AWS config (so a region set
 * only in `~/.aws/config` still works), since we need it to derive the state bucket
 * name.
 */
export async function createClients(opts: GlobalOpts): Promise<AwsClients> {
  if (opts.profile) {
    process.env.AWS_PROFILE = opts.profile;
  }

  let region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    try {
      region = await new S3Client({}).config.region();
    } catch {
      region = undefined;
    }
  }
  if (!region) {
    throw new CliError("could not determine an AWS region", {
      hint: "pass --region, set AWS_REGION, or run `aws configure`",
    });
  }

  const config = { region } as const;
  return {
    region,
    s3: new S3Client(config),
    ecr: new ECRClient(config),
    sts: new STSClient(config),
    ec2: new EC2Client(config),
    iam: new IAMClient(config),
    ssm: new SSMClient(config),
    logs: new CloudWatchLogsClient(config),
    sns: new SNSClient(config),
    sqs: new SQSClient(config),
  };
}
