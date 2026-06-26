import { stateBucketName } from "@agentsystemlabs/launch-pad-shared";
import type { IamPolicyDocument } from "./operator-policy";

export interface ProjectDeployPolicyParams {
  accountId: string;
  region: string;
  /** The dedicated, NON-default cluster this CI role may write. */
  cluster: string;
  /** The launch-pad.toml `project` whose ECR repos + secrets this role may touch. */
  project: string;
}

/**
 * The **bare-minimum** IAM policy for a CI deploy role that does nothing but
 * `deploy --cluster <cluster> --no-create --no-repair --no-recreate` for ONE project.
 *
 * It is the antithesis of {@link buildOperatorPolicy} (the trusted, account-wide
 * operator): a fully-compromised holder of this policy can do exactly two things —
 * push images to `<project>/*` ECR repos, and read/write S3 state under the single
 * `clusters/<cluster>/` prefix. It CANNOT touch another cluster's state, another
 * project's ECR or secrets, provision/terminate EC2, or create IAM roles.
 *
 * Why each statement is the minimum a deploy-only run actually calls (traced against
 * `commands/deploy.ts` with the three `--no-*` provisioning flags set):
 *
 *   - S3 bucket-level — `HeadBucket` (maps to `s3:ListBucket`, no prefix) + the
 *     unconditional `PutBucketTagging` that `ensureBucket` does on every run, plus
 *     `GetBucketLocation`. ListBucket is intentionally NOT prefix-conditioned because
 *     HeadBucket carries no prefix; the *objects* are scoped instead (next statement).
 *   - S3 objects — Get/Put/Delete confined to `clusters/<cluster>/*`, which is the
 *     ENTIRE write surface of a named cluster (desired.json, edge.json, config
 *     baseline, deploy events, project index, build contexts). This is what makes the
 *     role single-cluster: it physically cannot write `default`'s root keys or any
 *     other `clusters/<other>/` prefix.
 *   - ECR — push/pull confined to the project's `<project>/*` repo namespace; the
 *     registry-wide auth token has no resource scope.
 *   - SSM — read-only secrets under `/launch-pad/<cluster>/<project>/*`, plus the
 *     public AL2023 AMI parameter the planner may resolve.
 *   - EC2 — read-only `DescribeInstances`/`DescribeInstanceStatus` (a `--no-repair`
 *     deploy still *observes* console-side drift before publishing), region-gated.
 *     NO write actions: it can't run, stop, or terminate anything.
 *
 * Deliberately ABSENT vs the operator policy: every `ec2:*` write, all of `iam:*`,
 * `sns:*`/`sqs:*` (deploy notifications degrade gracefully to the agent's S3 poll),
 * `ssm:SendCommand`, `ssm:PutParameter`, CodeBuild, and any cross-cluster/-project
 * resource. Provisioning and node lifecycle stay a privileged, out-of-band operator
 * action — this role is for steady-state app deploys onto already-provisioned nodes.
 *
 * Requires a NON-default cluster: the `default` cluster's state lives at the bucket
 * root (`nodes/`, `projects/`), which can't be prefix-isolated from other projects.
 * Per-project isolation is exactly why the project gets its own named cluster.
 */
export function buildProjectDeployPolicy(params: ProjectDeployPolicyParams): IamPolicyDocument {
  const { accountId, region, cluster, project } = params;
  const bucket = stateBucketName(accountId, region);
  const bucketArn = `arn:aws:s3:::${bucket}`;

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
        // HeadBucket (s3:ListBucket, no prefix) + the unconditional PutBucketTagging
        // ensureBucket does each run + GetBucketLocation. Object access is scoped below.
        Sid: "StateBucketLevel",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:PutBucketTagging"],
        Resource: bucketArn,
      },
      {
        // The whole write surface of this ONE named cluster — and nothing else.
        Sid: "ClusterStateObjectsOnly",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`${bucketArn}/clusters/${cluster}/*`],
      },
      {
        // GetAuthorizationToken is a registry-wide token with no resource-level scope.
        Sid: "EcrAuth",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: ["*"],
      },
      {
        Sid: "EcrProjectReposOnly",
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
        Resource: [`arn:aws:ecr:${region}:${accountId}:repository/${project}/*`],
      },
      {
        Sid: "SecretsProjectClusterOnly",
        Effect: "Allow",
        Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        Resource: [`arn:aws:ssm:${region}:${accountId}:parameter/launch-pad/${cluster}/${project}/*`],
      },
      {
        // Resolving the latest AL2023 AMI reads a public AWS-owned SSM parameter.
        Sid: "SsmPublicAmiParam",
        Effect: "Allow",
        Action: ["ssm:GetParameter"],
        Resource: [`arn:aws:ssm:${region}::parameter/aws/service/*`],
      },
      {
        // Read-only: a --no-repair deploy still observes EC2 drift before publishing.
        // No write actions — this role can't run, stop, modify, or terminate instances.
        Sid: "Ec2ReadOnlyDriftObservation",
        Effect: "Allow",
        Action: ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"],
        Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": region } },
      },
    ],
  };
}

/** The policy as the pretty-printed JSON a user pastes into the IAM console. */
export function projectDeployPolicyJson(params: ProjectDeployPolicyParams): string {
  return `${JSON.stringify(buildProjectDeployPolicy(params), null, 2)}\n`;
}
