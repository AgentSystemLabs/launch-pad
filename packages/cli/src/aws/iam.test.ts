import { describe, expect, it } from "vitest";
import { buildAppPolicy, buildEdgePolicy, nodeProfileName, nodeRoleName } from "./iam";

interface Statement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[];
  Condition?: unknown;
}

describe("node IAM least privilege", () => {
  const bucket = "launch-pad-state-1-us-east-1";
  const region = "us-east-1";
  const accountId = "493255580566";

  it("derives per-node role and profile names", () => {
    expect(nodeRoleName("default", "app-1")).toBe("launch-pad-node-default-app-1");
    expect(nodeProfileName("lower", "edge-1")).toBe("launch-pad-node-profile-lower-edge-1");
  });

  it("scopes app policy to own desired/status and upstream shard writes", () => {
    const policy = JSON.parse(buildAppPolicy(bucket, "default", "app-1", region, accountId)) as {
      Statement: Array<{ Sid?: string; Action?: string | string[]; Resource?: string | string[]; Condition?: unknown }>;
    };

    const readDesired = policy.Statement.find((s) => s.Sid === "ReadDesired");
    expect(readDesired?.Resource).toEqual([
      `arn:aws:s3:::${bucket}/nodes/app-1/desired.json`,
    ]);

    const writeStatus = policy.Statement.find((s) => s.Sid === "WriteStatus");
    expect(writeStatus?.Resource).toEqual([`arn:aws:s3:::${bucket}/nodes/app-1/status.json`]);

    const publish = policy.Statement.find((s) => s.Sid === "PublishUpstream");
    expect(publish?.Resource).toEqual([
      `arn:aws:s3:::${bucket}/nodes/*/upstream/app-1.json`,
      `arn:aws:s3:::${bucket}/clusters/*/nodes/*/upstream/app-1.json`,
    ]);

    const listOwn = policy.Statement.find((s) => s.Sid === "ListOwnPrefix");
    expect(listOwn?.Condition).toEqual({
      StringLike: { "s3:prefix": ["nodes/app-1/*"] },
    });
  });

  it("grants app nodes cluster-scoped CloudWatch Logs write", () => {
    const policy = JSON.parse(buildAppPolicy(bucket, "default", "app-1", region, accountId)) as {
      Statement: Statement[];
    };
    const cw = policy.Statement.find((s) => s.Sid === "CloudWatchLogs");
    expect(cw?.Action).toEqual([
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
      "logs:PutRetentionPolicy",
    ]);
    expect(cw?.Resource).toBe(
      `arn:aws:logs:${region}:${accountId}:log-group:/launch-pad/default/*`,
    );
  });

  it("scopes edge policy to own upstream prefix, status, and CloudWatch Logs", () => {
    const policy = JSON.parse(buildEdgePolicy(bucket, "lower", "edge-1", region, accountId)) as {
      Statement: Statement[];
    };

    const readUpstream = policy.Statement.find((s) => s.Sid === "ReadUpstream");
    expect(readUpstream?.Resource).toEqual([
      `arn:aws:s3:::${bucket}/clusters/lower/nodes/edge-1/upstream/*`,
    ]);

    const writeStatus = policy.Statement.find((s) => s.Sid === "WriteStatus");
    expect(writeStatus?.Resource).toEqual([
      `arn:aws:s3:::${bucket}/clusters/lower/nodes/edge-1/status.json`,
    ]);

    const listUpstream = policy.Statement.find((s) => s.Sid === "ListUpstream");
    expect(listUpstream?.Condition).toEqual({
      StringLike: { "s3:prefix": ["clusters/lower/nodes/edge-1/upstream/*"] },
    });

    const cw = policy.Statement.find((s) => s.Sid === "CloudWatchLogs");
    expect(cw?.Resource).toBe(
      `arn:aws:logs:${region}:${accountId}:log-group:/launch-pad/lower/*`,
    );
  });
});
