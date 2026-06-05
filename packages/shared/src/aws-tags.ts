import type { NodeRole } from "./registry";

/** AWS tag key marking a resource as managed by launch-pad. */
export const AWS_TAG_MANAGED = "launch-pad" as const;

/** Value for {@link AWS_TAG_MANAGED} on all created resources. */
export const AWS_TAG_MANAGED_VALUE = "true" as const;

export const AWS_TAG_CLUSTER = "launch-pad:cluster" as const;
export const AWS_TAG_NODE = "launch-pad:node" as const;
export const AWS_TAG_ROLE = "launch-pad:role" as const;
export const AWS_TAG_PROJECT = "launch-pad:project" as const;
export const AWS_TAG_SERVICE = "launch-pad:service" as const;

export interface AwsTag {
  Key: string;
  Value: string;
}

export function managedTag(): AwsTag {
  return { Key: AWS_TAG_MANAGED, Value: AWS_TAG_MANAGED_VALUE };
}

export interface NodeResourceTagParams {
  clusterId: string;
  nodeId: string;
  role: NodeRole;
}

/** Tags for EC2 instances, volumes, EIPs, security groups, and per-node IAM. */
export function nodeResourceTags(p: NodeResourceTagParams): AwsTag[] {
  return [
    managedTag(),
    { Key: AWS_TAG_CLUSTER, Value: p.clusterId },
    { Key: AWS_TAG_NODE, Value: p.nodeId },
    { Key: AWS_TAG_ROLE, Value: p.role },
    { Key: "Name", Value: `launch-pad-${p.nodeId}` },
  ];
}

export interface BucketTagParams {
  clusterId: string;
}

/** Tags for the account/region-scoped S3 state bucket. */
export function bucketTags(p: BucketTagParams): AwsTag[] {
  return [managedTag(), { Key: AWS_TAG_CLUSTER, Value: p.clusterId }];
}

export interface EcrRepoTagParams {
  project: string;
  service: string;
}

/** Tags for ECR repositories created at deploy time. */
export function ecrRepoTags(p: EcrRepoTagParams): AwsTag[] {
  return [
    managedTag(),
    { Key: AWS_TAG_PROJECT, Value: p.project },
    { Key: AWS_TAG_SERVICE, Value: p.service },
  ];
}
