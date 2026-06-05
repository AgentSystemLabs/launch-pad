import { CreateTagsCommand } from "@aws-sdk/client-ec2";
import { TagResourceCommand } from "@aws-sdk/client-ecr";
import { TagInstanceProfileCommand, TagRoleCommand } from "@aws-sdk/client-iam";
import { PutBucketTaggingCommand } from "@aws-sdk/client-s3";
import { nodeResourceTags } from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it, vi } from "vitest";
import {
  ensureBucketTags,
  ensureEc2ResourceTags,
  ensureEcrRepoTags,
  ensureNodeIamTags,
} from "./tags";

describe("ensure*Tags helpers", () => {
  const nodeTags = nodeResourceTags({ clusterId: "default", nodeId: "app-1", role: "app" });

  it("ensureEc2ResourceTags sends CreateTags", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ec2 = { send } as never;
    await ensureEc2ResourceTags(ec2, "sg-abc", nodeTags);
    expect(send).toHaveBeenCalledWith(expect.any(CreateTagsCommand));
    const cmd = send.mock.calls[0]![0] as CreateTagsCommand;
    expect(cmd.input).toEqual({
      Resources: ["sg-abc"],
      Tags: nodeTags.map((t) => ({ Key: t.Key, Value: t.Value })),
    });
  });

  it("ensureNodeIamTags tags role and instance profile", async () => {
    const send = vi.fn().mockResolvedValue({});
    const iam = { send } as never;
    await ensureNodeIamTags(iam, {
      roleName: "launch-pad-node-default-app-1",
      profileName: "launch-pad-node-profile-default-app-1",
      tags: nodeTags,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(TagRoleCommand);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(TagInstanceProfileCommand);
  });

  it("ensureBucketTags sends PutBucketTagging", async () => {
    const send = vi.fn().mockResolvedValue({});
    const s3 = { send } as never;
    await ensureBucketTags(s3, "launch-pad-state-1-us-east-1", nodeTags.slice(0, 2));
    expect(send).toHaveBeenCalledWith(expect.any(PutBucketTaggingCommand));
  });

  it("ensureEcrRepoTags resolves repo ARN and tags", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        repositories: [{ repositoryArn: "arn:aws:ecr:us-east-1:1:repository/p/s" }],
      })
      .mockResolvedValueOnce({});
    const ecr = { send } as never;
    await ensureEcrRepoTags(ecr, "p/s", nodeTags.slice(0, 2));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(TagResourceCommand);
  });
});
