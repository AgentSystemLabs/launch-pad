import { describe, expect, it } from "vitest";
import {
  desiredKey,
  ecrRepositoryName,
  nodePrefix,
  nodeRegistryKey,
  stateBucketName,
  statusKey,
} from "./s3-keys";

describe("s3 key derivation", () => {
  it("derives an account+region scoped bucket name", () => {
    expect(stateBucketName("493255580566", "us-east-1")).toBe(
      "launch-pad-state-493255580566-us-east-1",
    );
  });

  it("derives node-scoped keys", () => {
    expect(nodePrefix("node-prod-1")).toBe("nodes/node-prod-1/");
    expect(nodeRegistryKey("node-prod-1")).toBe("nodes/node-prod-1/node.json");
    expect(desiredKey("node-prod-1")).toBe("nodes/node-prod-1/desired.json");
    expect(statusKey("node-prod-1")).toBe("nodes/node-prod-1/status.json");
  });

  it("derives an ECR repo name from project + service", () => {
    expect(ecrRepositoryName("my-app", "web")).toBe("my-app/web");
  });
});
