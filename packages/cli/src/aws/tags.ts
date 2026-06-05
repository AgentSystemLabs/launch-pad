import { CreateTagsCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, TagResourceCommand, type ECRClient } from "@aws-sdk/client-ecr";
import {
  TagInstanceProfileCommand,
  TagRoleCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { PutBucketTaggingCommand, type S3Client } from "@aws-sdk/client-s3";
import type { AwsTag } from "@agentsystemlabs/launch-pad-shared";

function toEc2Tags(tags: AwsTag[]) {
  return tags.map((t) => ({ Key: t.Key, Value: t.Value }));
}

function toS3Tags(tags: AwsTag[]) {
  return { TagSet: tags.map((t) => ({ Key: t.Key, Value: t.Value })) };
}

/** Apply (overwrite-merge) tags on an EC2-taggable resource (instance, volume, SG, EIP). */
export async function ensureEc2ResourceTags(
  ec2: EC2Client,
  resourceId: string,
  tags: AwsTag[],
): Promise<void> {
  if (tags.length === 0) return;
  await ec2.send(new CreateTagsCommand({ Resources: [resourceId], Tags: toEc2Tags(tags) }));
}

export async function ensureSecurityGroupTags(
  ec2: EC2Client,
  securityGroupId: string,
  tags: AwsTag[],
): Promise<void> {
  await ensureEc2ResourceTags(ec2, securityGroupId, tags);
}

export async function ensureNodeIamTags(
  iam: IAMClient,
  params: { roleName: string; profileName: string; tags: AwsTag[] },
): Promise<void> {
  const iamTags = params.tags.map((t) => ({ Key: t.Key, Value: t.Value }));
  await iam.send(new TagRoleCommand({ RoleName: params.roleName, Tags: iamTags }));
  await iam.send(
    new TagInstanceProfileCommand({
      InstanceProfileName: params.profileName,
      Tags: iamTags,
    }),
  );
}

export async function ensureBucketTags(s3: S3Client, bucket: string, tags: AwsTag[]): Promise<void> {
  if (tags.length === 0) return;
  await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: toS3Tags(tags) }));
}

export async function ensureEcrRepoTags(
  ecr: ECRClient,
  repositoryName: string,
  tags: AwsTag[],
): Promise<void> {
  if (tags.length === 0) return;
  const res = await ecr.send(
    new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }),
  );
  const arn = res.repositories?.[0]?.repositoryArn;
  if (!arn) return;
  await ecr.send(
    new TagResourceCommand({
      resourceArn: arn,
      tags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
    }),
  );
}
