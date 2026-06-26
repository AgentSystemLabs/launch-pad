import { describe, expect, it } from "vitest";
import { buildProjectDeployPolicy } from "./project-deploy-policy";

const ACCOUNT = "493255580566";
const REGION = "us-east-1";
const CLUSTER = "coffee-shop";
const PROJECT = "coffeeshop";
const BUCKET = `launch-pad-state-${ACCOUNT}-${REGION}`;

interface Stmt {
  Sid: string;
  Effect: string;
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

function policy() {
  return buildProjectDeployPolicy({ accountId: ACCOUNT, region: REGION, cluster: CLUSTER, project: PROJECT });
}

function stmt(sid: string): Stmt {
  const s = policy().Statement.find((x) => (x as Stmt).Sid === sid) as Stmt | undefined;
  if (!s) throw new Error(`no statement with Sid "${sid}"`);
  return s;
}

function resources(s: Stmt): string[] {
  return Array.isArray(s.Resource) ? s.Resource : [s.Resource];
}

function allActions(): string[] {
  return (policy().Statement as Stmt[]).flatMap((s) => s.Action);
}

describe("buildProjectDeployPolicy", () => {
  it("produces a valid IAM policy document", () => {
    const p = policy();
    expect(p.Version).toBe("2012-10-17");
    expect(Array.isArray(p.Statement)).toBe(true);
    for (const s of p.Statement as Stmt[]) {
      expect(s.Effect).toBe("Allow");
      expect(s.Sid).toMatch(/^[A-Za-z0-9]+$/);
      expect(s.Action.length).toBeGreaterThan(0);
    }
  });

  it("confines S3 object writes to this cluster's prefix and nothing else", () => {
    const s = stmt("ClusterStateObjectsOnly");
    expect(s.Action).toEqual(expect.arrayContaining(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]));
    expect(resources(s)).toEqual([`arn:aws:s3:::${BUCKET}/clusters/${CLUSTER}/*`]);
    // Must not grant the bucket root (default cluster) or any other cluster prefix.
    for (const r of resources(s)) {
      expect(r).not.toMatch(new RegExp(`${BUCKET}/(nodes|projects)/`));
      expect(r).not.toContain("clusters/*");
    }
  });

  it("bucket-level grant is read/list + tagging only (HeadBucket + ensureBucketTags), no object root", () => {
    const s = stmt("StateBucketLevel");
    expect(s.Action).toEqual(["s3:ListBucket", "s3:GetBucketLocation", "s3:PutBucketTagging"]);
    expect(resources(s)).toEqual([`arn:aws:s3:::${BUCKET}`]);
    expect(s.Action).not.toContain("s3:CreateBucket");
  });

  it("confines ECR to the project's repo namespace", () => {
    const s = stmt("EcrProjectReposOnly");
    expect(resources(s)).toEqual([`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${PROJECT}/*`]);
    expect(s.Action).toContain("ecr:PutImage");
  });

  it("confines secrets reads to this cluster + project and never writes them", () => {
    const s = stmt("SecretsProjectClusterOnly");
    expect(resources(s)).toEqual([`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/launch-pad/${CLUSTER}/${PROJECT}/*`]);
    expect(s.Action.every((a) => a.startsWith("ssm:Get"))).toBe(true);
    expect(s.Action).not.toContain("ssm:PutParameter");
    expect(s.Action).not.toContain("ssm:DeleteParameter");
  });

  it("grants EC2 read-only, region-gated, with no write actions", () => {
    const s = stmt("Ec2ReadOnlyDriftObservation");
    expect(s.Action).toEqual(["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"]);
    expect(s.Condition).toEqual({ StringEquals: { "aws:RequestedRegion": REGION } });
  });

  it("grants NONE of the dangerous operator powers (the whole point)", () => {
    const actions = allActions();
    const forbidden = [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:StopInstances",
      "ec2:ModifyInstanceAttribute",
      "iam:CreateRole",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "ssm:SendCommand",
      "ssm:PutParameter",
      "ssm:DeleteParameter",
      "sns:Publish",
      "sns:CreateTopic",
      "sqs:SendMessage",
      "codebuild:StartBuild",
    ];
    for (const f of forbidden) expect(actions).not.toContain(f);
    // No statement may use a bare account-wide "iam:*"/"ec2:*"-style write either.
    expect(actions.some((a) => a.startsWith("iam:"))).toBe(false);
  });

  it("isolates by cluster + project — changing either moves every scoped ARN", () => {
    const other = buildProjectDeployPolicy({ accountId: ACCOUNT, region: REGION, cluster: "other", project: "battleships" });
    const json = JSON.stringify(other);
    expect(json).toContain("clusters/other/*");
    expect(json).toContain("repository/battleships/*");
    expect(json).toContain("launch-pad/other/battleships/*");
    expect(json).not.toContain(CLUSTER);
    expect(json).not.toContain(PROJECT);
  });
});
