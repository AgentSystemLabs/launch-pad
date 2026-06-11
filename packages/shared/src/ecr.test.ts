import { describe, expect, it } from "vitest";
import { findPreviousImageTag, parseEcrImageUri } from "./ecr";

describe("parseEcrImageUri", () => {
  it("parses a standard ECR image URI (repository keeps its slash)", () => {
    expect(parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app/web:sha-abc123")).toEqual({
      registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
      repository: "my-app/web",
      tag: "sha-abc123",
    });
  });

  it("handles a single-segment repository", () => {
    expect(parseEcrImageUri("123456789012.dkr.ecr.eu-west-2.amazonaws.com/web:v1")).toEqual({
      registry: "123456789012.dkr.ecr.eu-west-2.amazonaws.com",
      repository: "web",
      tag: "v1",
    });
  });

  it("returns null when there is no tag", () => {
    expect(parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app/web")).toBeNull();
  });

  it("returns null for an empty tag", () => {
    expect(parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app/web:")).toBeNull();
  });

  it("returns null for a non-ECR registry (e.g. Docker Hub / GHCR)", () => {
    expect(parseEcrImageUri("ghcr.io/acme/web:v1")).toBeNull();
    expect(parseEcrImageUri("docker.io/library/nginx:latest")).toBeNull();
    expect(parseEcrImageUri("my-app/web:v1")).toBeNull();
  });

  it("returns null for a digest reference (we only deploy by immutable tag)", () => {
    expect(
      parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com/my-app/web@sha256:abcdef"),
    ).toBeNull();
  });

  it("returns null when the repository is missing", () => {
    expect(parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com:v1")).toBeNull();
    expect(parseEcrImageUri("123456789012.dkr.ecr.us-east-1.amazonaws.com/")).toBeNull();
  });

  it("returns null for empty / garbage input", () => {
    expect(parseEcrImageUri("")).toBeNull();
    expect(parseEcrImageUri("not a uri")).toBeNull();
    expect(parseEcrImageUri(":")).toBeNull();
  });
});

describe("findPreviousImageTag", () => {
  const images = [
    { tag: "v1", pushedAt: 1000 },
    { tag: "v2", pushedAt: 2000 },
    { tag: "v3", pushedAt: 3000 },
  ];

  it("picks the most-recent tag strictly older than the current one", () => {
    expect(findPreviousImageTag(images, "v3")).toBe("v2");
    expect(findPreviousImageTag(images, "v2")).toBe("v1");
  });

  it("returns null when the current tag is already the oldest", () => {
    expect(findPreviousImageTag(images, "v1")).toBeNull();
  });

  it("returns null when the current tag isn't in the list", () => {
    expect(findPreviousImageTag(images, "ghost")).toBeNull();
  });

  it("ignores tags newer than the current one (rollback never rolls forward)", () => {
    // current = v2 → previous must be v1, never v3 even though v3 is newest overall.
    expect(findPreviousImageTag(images, "v2")).toBe("v1");
  });

  it("is robust to unsorted input and Date pushedAt values", () => {
    const unsorted = [
      { tag: "b", pushedAt: new Date(2000) },
      { tag: "c", pushedAt: new Date(3000) },
      { tag: "a", pushedAt: new Date(1000) },
    ];
    expect(findPreviousImageTag(unsorted, "c")).toBe("b");
  });

  it("skips an entry with the same tag as current (no self-rollback)", () => {
    expect(findPreviousImageTag([{ tag: "only", pushedAt: 1 }], "only")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(findPreviousImageTag([], "v1")).toBeNull();
  });
});
