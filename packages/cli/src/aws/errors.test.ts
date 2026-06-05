import { describe, expect, it } from "vitest";
import {
  isDestroyAlreadyGoneError,
  isEc2AllocationNotFound,
  isEc2InstanceNotFound,
  isEc2SecurityGroupNotFound,
} from "./errors";

describe("destroy idempotency error detection", () => {
  it("recognizes missing EC2 instances", () => {
    expect(isEc2InstanceNotFound({ name: "InvalidInstanceID.NotFound" })).toBe(true);
    expect(isEc2InstanceNotFound({ name: "InvalidInstanceId" })).toBe(true);
    expect(isEc2InstanceNotFound({ name: "DependencyViolation" })).toBe(false);
  });

  it("recognizes missing security groups", () => {
    expect(isEc2SecurityGroupNotFound({ name: "InvalidGroup.NotFound" })).toBe(true);
    expect(isEc2SecurityGroupNotFound({ name: "InvalidGroupId.NotFound" })).toBe(true);
    expect(isEc2SecurityGroupNotFound({ name: "DependencyViolation" })).toBe(false);
  });

  it("recognizes missing Elastic IP allocations", () => {
    expect(isEc2AllocationNotFound({ name: "InvalidAllocationID.NotFound" })).toBe(true);
    expect(isEc2AllocationNotFound({ name: "InvalidInstanceID.NotFound" })).toBe(false);
  });

  it("groups all already-gone destroy errors", () => {
    expect(isDestroyAlreadyGoneError({ name: "InvalidInstanceID.NotFound" })).toBe(true);
    expect(isDestroyAlreadyGoneError({ name: "InvalidGroup.NotFound" })).toBe(true);
    expect(isDestroyAlreadyGoneError({ name: "InvalidAllocationID.NotFound" })).toBe(true);
    expect(isDestroyAlreadyGoneError({ name: "AccessDenied" })).toBe(false);
  });
});
