import { describe, expect, it } from "vitest";
import { buildOperatorPolicy } from "./operator-policy";

const ACCOUNT = "493255580566";
const REGION = "us-east-1";
const BUCKET = `launch-pad-state-${ACCOUNT}-${REGION}`;

interface Stmt {
  Sid: string;
  Effect: string;
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

function policy() {
  return buildOperatorPolicy({ accountId: ACCOUNT, region: REGION });
}

function stmt(sid: string): Stmt {
  const s = policy().Statement.find((x) => (x as Stmt).Sid === sid) as Stmt | undefined;
  if (!s) throw new Error(`no statement with Sid "${sid}"`);
  return s;
}

function resources(s: Stmt): string[] {
  return Array.isArray(s.Resource) ? s.Resource : [s.Resource];
}

describe("buildOperatorPolicy", () => {
  it("produces a valid IAM policy document", () => {
    const p = policy();
    expect(p.Version).toBe("2012-10-17");
    expect(Array.isArray(p.Statement)).toBe(true);
    expect(p.Statement.length).toBeGreaterThan(0);
    for (const s of p.Statement as Stmt[]) {
      expect(s.Effect).toBe("Allow");
      expect(s.Sid).toMatch(/^[A-Za-z0-9]+$/);
      expect(Array.isArray(s.Action)).toBe(true);
      expect(s.Action.length).toBeGreaterThan(0);
    }
  });

  it("never grants a wildcard action", () => {
    for (const s of policy().Statement as Stmt[]) {
      for (const a of s.Action) {
        expect(a).not.toBe("*");
        // No service-level wildcards like "s3:*" / "ec2:*".
        expect(a).not.toMatch(/^[a-z0-9-]+:\*$/);
      }
    }
  });

  it("every Sid is unique", () => {
    const sids = (policy().Statement as Stmt[]).map((s) => s.Sid);
    expect(new Set(sids).size).toBe(sids.length);
  });

  it("scopes the state bucket to launch-pad-state-<account>-<region>", () => {
    const bucket = stmt("StateBucket");
    expect(resources(bucket)).toContain(`arn:aws:s3:::${BUCKET}`);
    // Object-level access is a separate statement on /*.
    const objects = stmt("StateObjects");
    expect(resources(objects)).toEqual([`arn:aws:s3:::${BUCKET}/*`]);
    expect(objects.Action).toEqual(
      expect.arrayContaining(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
    );
    // Bucket-create/configure lives on the bucket ARN, never on /*.
    expect(bucket.Action).toEqual(expect.arrayContaining(["s3:CreateBucket", "s3:ListBucket"]));
    expect(resources(bucket)).not.toContain(`arn:aws:s3:::${BUCKET}/*`);
  });

  it("scopes ECR repo actions to this region+account, auth token to *", () => {
    const auth = stmt("EcrAuth");
    expect(auth.Action).toEqual(["ecr:GetAuthorizationToken"]);
    expect(resources(auth)).toEqual(["*"]);

    const repo = stmt("EcrRepos");
    expect(resources(repo)).toEqual([`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/*`]);
    // Build/push lifecycle + create/describe.
    expect(repo.Action).toEqual(
      expect.arrayContaining([
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
      ]),
    );
  });

  it("region-scopes EC2 with a RequestedRegion condition", () => {
    const ec2 = stmt("Ec2");
    expect(ec2.Condition?.StringEquals?.["aws:RequestedRegion"]).toBe(REGION);
    expect(ec2.Action).toEqual(
      expect.arrayContaining([
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:AllocateAddress",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:CreateTags",
        "ec2:ModifyInstanceAttribute",
      ]),
    );
  });

  it("scopes IAM role/profile management to launch-pad-node-* only", () => {
    for (const sid of ["IamNodeRole", "IamNodeProfile", "IamPassNodeRole"]) {
      for (const r of resources(stmt(sid))) {
        expect(r).toMatch(/launch-pad-node-\*$/);
      }
    }
    // Role mgmt on role ARNs, profile mgmt on instance-profile ARNs.
    expect(resources(stmt("IamNodeRole"))[0]).toBe(
      `arn:aws:iam::${ACCOUNT}:role/launch-pad-node-*`,
    );
    expect(resources(stmt("IamNodeProfile"))[0]).toBe(
      `arn:aws:iam::${ACCOUNT}:instance-profile/launch-pad-node-*`,
    );
  });

  it("restricts PassRole to EC2 and the node role prefix", () => {
    const pass = stmt("IamPassNodeRole");
    expect(pass.Action).toEqual(["iam:PassRole"]);
    expect(resources(pass)).toEqual([`arn:aws:iam::${ACCOUNT}:role/launch-pad-node-*`]);
    expect(pass.Condition?.StringEquals?.["iam:PassedToService"]).toBe("ec2.amazonaws.com");
  });

  it("restricts AttachRolePolicy to the SSM managed policy ARN", () => {
    const attach = stmt("IamAttachManagedPolicy");
    expect(attach.Action).toEqual(
      expect.arrayContaining(["iam:AttachRolePolicy", "iam:DetachRolePolicy"]),
    );
    expect(attach.Condition?.ArnEquals?.["iam:PolicyARN"]).toBe(
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    );
  });

  it("scopes secret parameters to /launch-pad/* and AMI lookups to the public namespace", () => {
    const secrets = stmt("SsmSecrets");
    expect(resources(secrets)).toEqual([
      `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/launch-pad/*`,
    ]);
    expect(secrets.Action).toEqual(
      expect.arrayContaining([
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:DeleteParameter",
      ]),
    );

    const ami = stmt("SsmPublicParams");
    expect(ami.Action).toEqual(["ssm:GetParameter"]);
    // Public AWS parameters live in the account-less `aws` namespace.
    expect(resources(ami)).toEqual([`arn:aws:ssm:${REGION}::parameter/aws/service/*`]);
  });

  it("allows Run Command only for AWS-RunShellScript on launch-pad instances", () => {
    const run = stmt("SsmRunCommand");
    expect(run.Action).toEqual(expect.arrayContaining(["ssm:SendCommand"]));
    const res = resources(run);
    expect(res).toContain(`arn:aws:ssm:${REGION}::document/AWS-RunShellScript`);
    expect(res).toContain(`arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*`);
  });

  it("grants KMS only via SSM (for SecureString secrets)", () => {
    const kms = stmt("SsmKms");
    expect(kms.Action).toEqual(
      expect.arrayContaining(["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]),
    );
    expect(kms.Condition?.StringEquals?.["kms:ViaService"]).toBe(`ssm.${REGION}.amazonaws.com`);
  });

  it("scopes CloudWatch Logs reads to the launch-pad namespace", () => {
    const logs = stmt("CloudWatchLogsRead");
    expect(logs.Action).toEqual(expect.arrayContaining(["logs:FilterLogEvents"]));
    expect(resources(logs).some((r) => r.includes(":log-group:/launch-pad/"))).toBe(true);
  });

  it("scopes Route53 record changes to hosted zones (global service, no region condition)", () => {
    // ListHostedZonesByName has no resource-level support — it must be `*` in its own statement.
    const list = stmt("Route53List");
    expect(list.Action).toEqual(["route53:ListHostedZonesByName"]);
    expect(resources(list)).toEqual(["*"]);
    expect(list.Condition).toBeUndefined();

    const records = stmt("Route53Records");
    expect(records.Action).toEqual(
      expect.arrayContaining([
        "route53:ListResourceRecordSets",
        "route53:ChangeResourceRecordSets",
        "route53:GetChange",
      ]),
    );
    const res = resources(records);
    // Record reads/changes scope to hosted-zone + change ARNs (account-less, region-less).
    expect(res).toContain("arn:aws:route53:::hostedzone/*");
    expect(res).toContain("arn:aws:route53:::change/*");
    // Route53 is global — a RequestedRegion condition would break it, so there must be none.
    expect(records.Condition).toBeUndefined();
  });

  it("includes sts:GetCallerIdentity", () => {
    const sts = stmt("Sts");
    expect(sts.Action).toEqual(["sts:GetCallerIdentity"]);
    expect(resources(sts)).toEqual(["*"]);
  });

  it("stays within the 6144-char managed-policy size limit when minified", () => {
    expect(JSON.stringify(policy()).length).toBeLessThanOrEqual(6144);
  });

  it("is deterministic for the same inputs", () => {
    expect(JSON.stringify(policy())).toBe(JSON.stringify(policy()));
  });
});
