import { describe, expect, it } from "vitest";
import {
  buildCodeBuildServicePolicy,
  codebuildTrustPolicy,
  dockerfileInContext,
  parseDockerignore,
  remoteBuildProjectName,
  remoteBuildRoleName,
  remoteBuildSpec,
  shouldExcludeFromContext,
} from "./remote-build";

describe("remote-build naming", () => {
  it("derives a per-cluster CodeBuild project name", () => {
    expect(remoteBuildProjectName("default")).toBe("launch-pad-build-default");
    expect(remoteBuildProjectName("e2e-rb-abc123")).toBe("launch-pad-build-e2e-rb-abc123");
  });

  it("sanitizes characters CodeBuild project names reject", () => {
    expect(remoteBuildProjectName("my.cluster")).toBe("launch-pad-build-my-cluster");
  });

  it("derives a per-cluster IAM service-role name within IAM's 64-char limit", () => {
    expect(remoteBuildRoleName("default")).toBe("launch-pad-codebuild-default");
    const long = remoteBuildRoleName("x".repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.startsWith("launch-pad-codebuild-")).toBe(true);
  });
});

describe("codebuild trust + service policy", () => {
  it("trusts only the CodeBuild service principal", () => {
    const trust = codebuildTrustPolicy() as {
      Statement: Array<{ Effect: string; Principal: { Service: string }; Action: string }>;
    };
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0]?.Principal.Service).toBe("codebuild.amazonaws.com");
    expect(trust.Statement[0]?.Action).toBe("sts:AssumeRole");
  });

  it("grants ECR auth + push, read of OWN-cluster build contexts only, and its own log group", () => {
    const doc = JSON.parse(
      buildCodeBuildServicePolicy({
        bucket: "launch-pad-state-123456789012-us-east-1",
        region: "us-east-1",
        accountId: "123456789012",
        clusterId: "default",
        projectName: "launch-pad-build-default",
      }),
    ) as { Version: string; Statement: Array<{ Sid: string; Action: string[]; Resource: string[] }> };

    const bySid = new Map(doc.Statement.map((s) => [s.Sid, s]));

    expect(bySid.get("EcrAuth")?.Action).toEqual(["ecr:GetAuthorizationToken"]);
    expect(bySid.get("EcrPush")?.Action).toEqual(
      expect.arrayContaining(["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:BatchCheckLayerAvailability"]),
    );
    expect(bySid.get("EcrPush")?.Resource).toEqual([
      "arn:aws:ecr:us-east-1:123456789012:repository/*",
    ]);

    // S3 read must be scoped to the cluster's OWN builds/ prefix — never the whole
    // state bucket (desired.json carries plaintext env vars a build container has no
    // business reading) and never another cluster's uploaded contexts.
    expect(bySid.get("ReadBuildContexts")?.Action).toEqual(["s3:GetObject"]);
    expect(bySid.get("ReadBuildContexts")?.Resource).toEqual([
      "arn:aws:s3:::launch-pad-state-123456789012-us-east-1/projects/*/builds/*",
    ]);

    expect(bySid.get("BuildLogs")?.Resource).toEqual([
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/codebuild/launch-pad-build-default",
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/codebuild/launch-pad-build-default:*",
    ]);
  });

  it("scopes a named cluster's build-context read under clusters/<id>/ only", () => {
    const doc = JSON.parse(
      buildCodeBuildServicePolicy({
        bucket: "launch-pad-state-123456789012-us-east-1",
        region: "us-east-1",
        accountId: "123456789012",
        clusterId: "prod",
        projectName: "launch-pad-build-prod",
      }),
    ) as { Statement: Array<{ Sid: string; Resource: string[] }> };
    const read = doc.Statement.find((s) => s.Sid === "ReadBuildContexts");
    expect(read?.Resource).toEqual([
      "arn:aws:s3:::launch-pad-state-123456789012-us-east-1/clusters/prod/projects/*/builds/*",
    ]);
  });
});

describe("remoteBuildSpec", () => {
  it("downloads the context, logs in to ECR, builds for linux/amd64, and pushes", () => {
    const spec = remoteBuildSpec();
    expect(spec).toContain("version: 0.2");
    expect(spec).toContain('aws s3 cp "s3://$CONTEXT_BUCKET/$CONTEXT_KEY"');
    expect(spec).toContain("docker login --username AWS --password-stdin");
    // The wire contract with nodes: images are always linux/amd64 — keep the remote
    // build identical to the local buildx path.
    expect(spec).toContain("--platform linux/amd64");
    expect(spec).toContain('docker build');
    expect(spec).toContain('-f "/tmp/build-context/$DOCKERFILE"');
    expect(spec).toContain('docker push "$IMAGE_URI"');
  });

  it("pushes in the SAME phase as the build, so a failed build never attempts a push", () => {
    const spec = remoteBuildSpec();
    // CodeBuild still runs post_build when the build phase fails — a push there
    // would cascade a confusing second error on every failed build.
    expect(spec).not.toContain("post_build");
    expect(spec.indexOf("docker build")).toBeLessThan(spec.indexOf("docker push"));
  });
});

describe("dockerfileInContext", () => {
  it("returns the context-relative posix path for a dockerfile inside the context", () => {
    expect(dockerfileInContext("/repo/app", "/repo/app/Dockerfile")).toBe("Dockerfile");
    expect(dockerfileInContext("/repo", "/repo/services/web/Dockerfile")).toBe(
      "services/web/Dockerfile",
    );
  });

  it("returns null when the dockerfile escapes the context (cannot ship in the tarball)", () => {
    expect(dockerfileInContext("/repo/app", "/repo/Dockerfile")).toBeNull();
    expect(dockerfileInContext("/repo/app", "/elsewhere/Dockerfile")).toBeNull();
  });
});

describe("dockerignore → context tar exclusions", () => {
  it("keeps literal patterns; a negation disables glob handling (build correctness first)", () => {
    const patterns = parseDockerignore(
      ["# comment", "", "node_modules", ".git", "dist/", "*.md", "!keep.md", "a/b"].join("\n"),
    );
    expect(patterns).toEqual(["node_modules", ".git", "dist", "a/b"]);
  });

  it("normalizes leading ./ and / to root-relative paths", () => {
    expect(parseDockerignore("/node_modules\n./coverage")).toEqual(["node_modules", "coverage"]);
  });

  it("supports the common secret-glob forms when no negation is present", () => {
    // `.env*`-style files must NOT be uploaded to S3 just because the exclusion
    // used a glob — these are the patterns people protect secrets with.
    expect(parseDockerignore("*.pem\n**/*.key\n**/secrets\n.env*")).toEqual([
      "*.pem",
      "**/*.key",
      "**/secrets",
      ".env*",
    ]);
    // Unsupported glob shapes are still skipped (docker re-applies them remotely).
    expect(parseDockerignore("a/*/b\nfoo?bar\n[ab].txt")).toEqual([]);
  });

  it("drops a literal exclusion that a negation re-includes under", () => {
    // `dist` + `!dist/keep.js`: excluding dist from the tarball would break the
    // build (docker re-includes dist/keep.js) — keep dist in the upload.
    expect(parseDockerignore("dist\nnode_modules\n!dist/keep.js")).toEqual(["node_modules"]);
    // A wildcard negation defeats reasoning entirely — upload everything.
    expect(parseDockerignore("dist\n!*.keep")).toEqual([]);
  });

  it("excludes a matching path and everything under it — and .git always", () => {
    expect(shouldExcludeFromContext("node_modules", ["node_modules"])).toBe(true);
    expect(shouldExcludeFromContext("node_modules/express/index.js", ["node_modules"])).toBe(true);
    expect(shouldExcludeFromContext(".git/HEAD", [])).toBe(true);
    expect(shouldExcludeFromContext("src/index.ts", ["node_modules"])).toBe(false);
    // A literal pattern is root-anchored, exactly like .dockerignore semantics —
    // it must NOT exclude a nested directory of the same name.
    expect(shouldExcludeFromContext("packages/x/node_modules-tools", ["node_modules"])).toBe(false);
    expect(shouldExcludeFromContext("src/node_modules/x.js", ["node_modules"])).toBe(false);
  });

  it("matches glob patterns with docker's anchoring (root-level for *, any depth for **/)", () => {
    expect(shouldExcludeFromContext("cert.pem", ["*.pem"])).toBe(true);
    expect(shouldExcludeFromContext("sub/cert.pem", ["*.pem"])).toBe(false); // *.pem is root-only
    expect(shouldExcludeFromContext("sub/deep/host.key", ["**/*.key"])).toBe(true);
    expect(shouldExcludeFromContext("host.key", ["**/*.key"])).toBe(true);
    expect(shouldExcludeFromContext("a/secrets/token", ["**/secrets"])).toBe(true);
    expect(shouldExcludeFromContext("secrets", ["**/secrets"])).toBe(true);
    expect(shouldExcludeFromContext("a/secretsfile", ["**/secrets"])).toBe(false);
    expect(shouldExcludeFromContext(".env.local", [".env*"])).toBe(true);
    expect(shouldExcludeFromContext("conf/.env.local", [".env*"])).toBe(false); // root-only
  });
});
