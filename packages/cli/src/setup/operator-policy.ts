import { stateBucketName } from "@agentsystemlabs/launch-pad-shared";

/** AWS-managed policy the per-node role gets (for SSM Run Command / Session Manager). */
const SSM_MANAGED_INSTANCE_CORE_ARN = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

/** Every per-node IAM role/profile launch-pad creates shares this name prefix. */
const NODE_IAM_PREFIX = "launch-pad-node-";

export interface OperatorPolicyParams {
  accountId: string;
  region: string;
}

export interface IamStatement {
  Sid: string;
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface IamPolicyDocument {
  Version: "2012-10-17";
  Statement: IamStatement[];
}

/**
 * Least-privilege IAM policy for the **operator** principal — the human (or CI role)
 * that runs `launch-pad deploy` / `node` / `cluster`. It is the mirror of the per-node
 * policies in `aws/iam.ts`: that file scopes what a *node* may do; this scopes what the
 * *operator* may do to provision and manage nodes.
 *
 * Every statement maps to a concrete AWS SDK call the CLI makes, scoped to launch-pad's
 * resources wherever the action supports resource-level permissions:
 *
 *   - S3 state bucket — only `launch-pad-state-<account>-<region>` and its objects.
 *   - ECR — repository actions on this account+region; the auth token is account-wide
 *     (the API has no resource-level scope for it).
 *   - EC2 — `*` resource (most EC2 actions don't support fine-grained ARNs here), but
 *     gated to a single `aws:RequestedRegion` so the operator can only touch one region.
 *   - IAM — only the `launch-pad-node-*` roles/profiles it creates; PassRole is pinned
 *     to EC2; AttachRolePolicy is pinned to the one AWS-managed policy a node needs.
 *   - SSM — secrets under `/launch-pad/*`, the public AMI parameter, and Run Command
 *     limited to `AWS-RunShellScript` on this account's instances.
 *   - KMS — only via SSM (so SecureString secrets encrypt/decrypt against `aws/ssm`).
 *   - CloudWatch Logs — read-only over the `/launch-pad/*` log groups (`launch-pad logs`).
 *
 * Keep this in lock-step with the AWS SDK calls in `packages/cli/src/aws/*` — a new
 * `new XxxCommand()` there usually means a new action here.
 */
export function buildOperatorPolicy(params: OperatorPolicyParams): IamPolicyDocument {
  const { accountId, region } = params;
  const bucket = stateBucketName(accountId, region);
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const nodeRoleArn = `arn:aws:iam::${accountId}:role/${NODE_IAM_PREFIX}*`;
  const nodeProfileArn = `arn:aws:iam::${accountId}:instance-profile/${NODE_IAM_PREFIX}*`;

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Sts",
        Effect: "Allow",
        Action: ["sts:GetCallerIdentity"],
        Resource: ["*"],
      },
      {
        // Bucket-level: create + configure the state bucket, and ListBucket so a
        // GetObject on a not-yet-existing key returns 404, not 403. Unlike the per-node
        // policies (which `s3:prefix`-scope ListBucket to one node), the operator
        // legitimately lists across all nodes/, clusters/ and projects/ prefixes — so no
        // prefix condition applies here.
        Sid: "StateBucket",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:PutBucketVersioning",
          "s3:PutEncryptionConfiguration",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketTagging",
        ],
        Resource: bucketArn,
      },
      {
        Sid: "StateObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`${bucketArn}/*`],
      },
      {
        // GetAuthorizationToken has no resource-level scope (it's a registry-wide token).
        Sid: "EcrAuth",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: ["*"],
      },
      {
        Sid: "EcrRepos",
        Effect: "Allow",
        Action: [
          "ecr:CreateRepository",
          "ecr:DescribeRepositories",
          "ecr:DescribeImages",
          "ecr:ListImages",
          "ecr:TagResource",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ],
        Resource: [`arn:aws:ecr:${region}:${accountId}:repository/*`],
      },
      {
        // EC2 actions largely don't support resource-level ARNs for this provisioning
        // flow (RunInstances/Allocate/etc.), so we gate the whole service to one region.
        Sid: "Ec2",
        Effect: "Allow",
        Action: [
          "ec2:RunInstances",
          "ec2:StartInstances",
          "ec2:StopInstances",
          "ec2:TerminateInstances",
          "ec2:ModifyInstanceAttribute",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeImages",
          "ec2:DescribeVpcs",
          "ec2:DescribeAddresses",
          "ec2:DescribeSecurityGroups",
          "ec2:AllocateAddress",
          "ec2:AssociateAddress",
          "ec2:DisassociateAddress",
          "ec2:ReleaseAddress",
          "ec2:CreateSecurityGroup",
          "ec2:DeleteSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CreateTags",
        ],
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": region } },
      },
      {
        // The operator creates/manages the per-node roles, so it can put inline policies
        // on `launch-pad-node-*` roles and (via IamPassNodeRole below) pass them to EC2.
        // That means a malicious operator could craft a node role broader than the
        // per-node least-privilege envelope. This policy is for a TRUSTED operator (the
        // human/CI that already runs deploys), not for untrusted delegation. To harden
        // for the latter, add an `iam:PermissionsBoundary` condition here and have
        // provision-node create roles with that boundary.
        Sid: "IamNodeRole",
        Effect: "Allow",
        Action: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:TagRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
        ],
        Resource: [nodeRoleArn],
      },
      {
        // AttachRolePolicy/DetachRolePolicy is pinned (via iam:PolicyARN) to the one
        // AWS-managed policy a node needs — it can't attach an arbitrary policy.
        Sid: "IamAttachManagedPolicy",
        Effect: "Allow",
        Action: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
        Resource: [nodeRoleArn],
        Condition: { ArnEquals: { "iam:PolicyARN": SSM_MANAGED_INSTANCE_CORE_ARN } },
      },
      {
        Sid: "IamNodeProfile",
        Effect: "Allow",
        Action: [
          "iam:CreateInstanceProfile",
          "iam:DeleteInstanceProfile",
          "iam:GetInstanceProfile",
          "iam:TagInstanceProfile",
          "iam:AddRoleToInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile",
        ],
        Resource: [nodeProfileArn],
      },
      {
        // RunInstances passes the per-node instance profile's role to EC2.
        Sid: "IamPassNodeRole",
        Effect: "Allow",
        Action: ["iam:PassRole"],
        Resource: [nodeRoleArn],
        Condition: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } },
      },
      {
        // Account-wide over /launch-pad/* (all clusters), so one operator manages every
        // cluster's secrets — broader than the per-node policy, which scopes to one
        // cluster. For a per-cluster CI role, tighten to /launch-pad/<cluster>/*.
        Sid: "SsmSecrets",
        Effect: "Allow",
        Action: [
          "ssm:PutParameter",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "ssm:DeleteParameter",
        ],
        Resource: [`arn:aws:ssm:${region}:${accountId}:parameter/launch-pad/*`],
      },
      {
        // Resolving the latest AL2023 AMI reads a public AWS-owned SSM parameter
        // (account-less ARN in the `aws` namespace).
        Sid: "SsmPublicParams",
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: [`arn:aws:ssm:${region}::parameter/aws/service/*`],
      },
      {
        // `node upgrade-agent` / live monitoring run a shell script on launch-pad nodes.
        Sid: "SsmRunCommand",
        Effect: "Allow",
        Action: ["ssm:SendCommand", "ssm:GetCommandInvocation"],
        Resource: [
          `arn:aws:ssm:${region}::document/AWS-RunShellScript`,
          `arn:aws:ec2:${region}:${accountId}:instance/*`,
        ],
      },
      {
        // SecureString secrets encrypt/decrypt against the default `aws/ssm` key — grant
        // KMS only when the call goes *through* SSM, never directly.
        Sid: "SsmKms",
        Effect: "Allow",
        Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
        Resource: "*",
        Condition: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` } },
      },
      {
        // `launch-pad logs` reads service log groups via FilterLogEvents only. The node's
        // CloudWatch agent (not the operator) is what creates/describes groups, so the
        // resource-scopeable FilterLogEvents is all the operator needs.
        Sid: "CloudWatchLogsRead",
        Effect: "Allow",
        Action: ["logs:FilterLogEvents"],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/launch-pad/*:*`],
      },
      {
        // `launch-pad dns setup` writes DNS-only A records to a Route53 hosted zone.
        // Route53 is a GLOBAL service (ARNs carry no region/account), so neither Route53
        // statement carries an `aws:RequestedRegion` condition — that would reject every
        // call. ListHostedZonesByName has NO resource-level scope, so it must be `*` in
        // its own statement; scoping it to a hosted-zone ARN would deny the action.
        Sid: "Route53List",
        Effect: "Allow",
        Action: ["route53:ListHostedZonesByName"],
        Resource: ["*"],
      },
      {
        // Record reads/changes scope to hosted zones; GetChange to the change resource.
        // Granting this lets the operator change records in any zone the account owns —
        // acceptable for the trusted operator/CI principal (DNS is opt-in via `dns setup`).
        // Tighten to a specific `arn:aws:route53:::hostedzone/<id>` for a single-domain CI role.
        Sid: "Route53Records",
        Effect: "Allow",
        Action: [
          "route53:ListResourceRecordSets",
          "route53:ChangeResourceRecordSets",
          "route53:GetChange",
        ],
        Resource: ["arn:aws:route53:::hostedzone/*", "arn:aws:route53:::change/*"],
      },
    ],
  };
}

/** The policy as the pretty-printed JSON a user pastes into the IAM console. */
export function operatorPolicyJson(params: OperatorPolicyParams): string {
  return `${JSON.stringify(buildOperatorPolicy(params), null, 2)}\n`;
}
