import { describe, expect, it } from "vitest";
import { buildEnvironmentOverrides } from "./codebuild";

describe("buildEnvironmentOverrides", () => {
  it("uses the project defaults for amd64 builds", () => {
    expect(buildEnvironmentOverrides("linux/amd64")).toEqual({});
  });

  it("runs arm64 builds on an ARM CodeBuild environment", () => {
    expect(buildEnvironmentOverrides("linux/arm64")).toEqual({
      environmentTypeOverride: "ARM_CONTAINER",
      imageOverride: "aws/codebuild/amazonlinux2-aarch64-standard:3.0",
      computeTypeOverride: "BUILD_GENERAL1_SMALL",
      privilegedModeOverride: true,
    });
  });
});
