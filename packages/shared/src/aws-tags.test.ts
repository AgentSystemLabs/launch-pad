import { describe, expect, it } from "vitest";
import {
  AWS_TAG_CLUSTER,
  AWS_TAG_MANAGED,
  AWS_TAG_NODE,
  AWS_TAG_PROJECT,
  AWS_TAG_ROLE,
  AWS_TAG_SERVICE,
  bucketTags,
  ecrRepoTags,
  managedTag,
  nodeResourceTags,
} from "./aws-tags";

describe("aws-tags", () => {
  it("managedTag is launch-pad=true", () => {
    expect(managedTag()).toEqual({ Key: AWS_TAG_MANAGED, Value: "true" });
  });

  it("nodeResourceTags includes managed, cluster, node, role, and Name", () => {
    const tags = nodeResourceTags({ clusterId: "prod", nodeId: "app-1", role: "app" });
    expect(tags).toEqual([
      { Key: AWS_TAG_MANAGED, Value: "true" },
      { Key: AWS_TAG_CLUSTER, Value: "prod" },
      { Key: AWS_TAG_NODE, Value: "app-1" },
      { Key: AWS_TAG_ROLE, Value: "app" },
      { Key: "Name", Value: "launch-pad-app-1" },
    ]);
  });

  it("bucketTags includes managed and cluster", () => {
    expect(bucketTags({ clusterId: "default" })).toEqual([
      { Key: AWS_TAG_MANAGED, Value: "true" },
      { Key: AWS_TAG_CLUSTER, Value: "default" },
    ]);
  });

  it("ecrRepoTags includes managed, project, and service", () => {
    expect(ecrRepoTags({ project: "acme", service: "api" })).toEqual([
      { Key: AWS_TAG_MANAGED, Value: "true" },
      { Key: AWS_TAG_PROJECT, Value: "acme" },
      { Key: AWS_TAG_SERVICE, Value: "api" },
    ]);
  });
});
