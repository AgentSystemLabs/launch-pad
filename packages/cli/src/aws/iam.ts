import {
  AddRoleToInstanceProfileCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  GetInstanceProfileCommand,
  type IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { awsErrorName } from "./errors";

export const NODE_ROLE_NAME = "launch-pad-node-role";
export const NODE_PROFILE_NAME = "launch-pad-node-profile";
const NODE_POLICY_NAME = "launch-pad-node-policy";

/** IAM reports an existing entity as `EntityAlreadyExistsException` (Exception suffix). */
function isAlreadyExists(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === "EntityAlreadyExists" || name === "EntityAlreadyExistsException";
}

const TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

/** Least-privilege policy: agent reads/writes its node state in S3, pulls from ECR. */
function nodePolicy(bucket: string, region: string, accountId: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "NodeState",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject"],
        Resource: [`arn:aws:s3:::${bucket}/nodes/*`],
      },
      {
        // Required so GetObject on a missing key returns 404 (not 403) — the agent
        // reads desired.json before anything is deployed.
        Sid: "NodeList",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Sid: "EcrAuth",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: ["*"],
      },
      {
        Sid: "EcrPull",
        Effect: "Allow",
        Action: [
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchCheckLayerAvailability",
        ],
        Resource: [`arn:aws:ecr:${region}:${accountId}:repository/*`],
      },
    ],
  });
}

/** Idempotently ensure the node IAM role exists with the current inline policy. */
export async function ensureNodeRole(
  iam: IAMClient,
  bucket: string,
  region: string,
  accountId: string,
): Promise<void> {
  try {
    await iam.send(
      new CreateRoleCommand({
        RoleName: NODE_ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify(TRUST_POLICY),
        Description: "launch-pad node agent role (S3 state + ECR pull)",
      }),
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  // Always (re)write the inline policy so it stays current with the bucket/account.
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: NODE_ROLE_NAME,
      PolicyName: NODE_POLICY_NAME,
      PolicyDocument: nodePolicy(bucket, region, accountId),
    }),
  );
}

/** Idempotently ensure the instance profile exists and references the node role. */
export async function ensureInstanceProfile(iam: IAMClient): Promise<string> {
  try {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: NODE_PROFILE_NAME }));
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const profile = await iam.send(
    new GetInstanceProfileCommand({ InstanceProfileName: NODE_PROFILE_NAME }),
  );
  const hasRole = profile.InstanceProfile?.Roles?.some((r) => r.RoleName === NODE_ROLE_NAME);
  if (!hasRole) {
    await iam.send(
      new AddRoleToInstanceProfileCommand({
        InstanceProfileName: NODE_PROFILE_NAME,
        RoleName: NODE_ROLE_NAME,
      }),
    );
  }
  return NODE_PROFILE_NAME;
}
