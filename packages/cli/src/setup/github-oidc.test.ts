import { describe, expect, it } from "vitest";
import {
  buildDeployWorkflow,
  buildOidcTrustPolicy,
  githubSubject,
  oidcProviderArn,
  parseRepo,
  validateBranch,
  validateRoleName,
} from "./github-oidc";

const ACCOUNT = "493255580566";

describe("parseRepo", () => {
  it("splits owner/name", () => {
    expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "acme", "acme/", "/widgets", "a/b/c", "acme/wid gets"]) {
      expect(() => parseRepo(bad)).toThrow();
    }
  });
});

describe("githubSubject", () => {
  it("scopes to a single branch by default", () => {
    expect(githubSubject({ owner: "acme", repo: "widgets", branch: "main" })).toBe(
      "repo:acme/widgets:ref:refs/heads/main",
    );
  });

  it("opens to any ref when branch is omitted", () => {
    expect(githubSubject({ owner: "acme", repo: "widgets" })).toBe("repo:acme/widgets:*");
  });
});

describe("validateBranch", () => {
  it("accepts plain ref segments", () => {
    for (const ok of ["main", "release", "feature/x", "v1.2", "release-2024"]) {
      expect(validateBranch(ok)).toBe(ok);
    }
  });

  it("rejects wildcards, colons, and traversal that would widen the OIDC subject", () => {
    for (const bad of ["*", "refs/heads/*", "a:b", "has space", "../x", "", "/leading"]) {
      expect(() => validateBranch(bad)).toThrow();
    }
  });
});

describe("validateRoleName", () => {
  it("accepts IAM-legal role names", () => {
    for (const ok of ["launch-pad-deploy", "Deploy_Role", "ci.deploy@team"]) {
      expect(validateRoleName(ok)).toBe(ok);
    }
  });

  it("rejects out-of-charset or oversized names", () => {
    for (const bad of ["bad name", "role/slash", "x".repeat(65), ""]) {
      expect(() => validateRoleName(bad)).toThrow();
    }
  });
});

describe("oidcProviderArn", () => {
  it("points at the GitHub Actions OIDC provider", () => {
    expect(oidcProviderArn(ACCOUNT)).toBe(
      `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    );
  });
});

describe("buildOidcTrustPolicy", () => {
  const policy = buildOidcTrustPolicy({
    accountId: ACCOUNT,
    subject: "repo:acme/widgets:ref:refs/heads/main",
  });
  const stmt = policy.Statement[0]!;

  it("federates the GitHub OIDC provider via web identity", () => {
    expect(policy.Version).toBe("2012-10-17");
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(stmt.Principal.Federated).toBe(oidcProviderArn(ACCOUNT));
  });

  it("pins the audience to sts.amazonaws.com", () => {
    expect(stmt.Condition.StringEquals["token.actions.githubusercontent.com:aud"]).toBe(
      "sts.amazonaws.com",
    );
  });

  it("pins the subject (repo + ref) so other repos can't assume the role", () => {
    expect(stmt.Condition.StringLike["token.actions.githubusercontent.com:sub"]).toBe(
      "repo:acme/widgets:ref:refs/heads/main",
    );
  });
});

describe("buildDeployWorkflow", () => {
  const yaml = buildDeployWorkflow({
    roleArn: `arn:aws:iam::${ACCOUNT}:role/launch-pad-deploy`,
    region: "us-east-1",
    branch: "main",
  });

  it("requests the id-token permission for OIDC", () => {
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("contents: read");
  });

  it("assumes the deploy role and configures the region", () => {
    expect(yaml).toContain("aws-actions/configure-aws-credentials");
    expect(yaml).toContain(`role-to-assume: arn:aws:iam::${ACCOUNT}:role/launch-pad-deploy`);
    expect(yaml).toContain("aws-region: us-east-1");
  });

  it("runs a non-interactive deploy", () => {
    expect(yaml).toContain("launch-pad deploy --yes");
  });

  it("triggers on pushes to the configured branch", () => {
    expect(yaml).toMatch(/branches:\s*\[\s*main\s*\]/);
  });

  it("checks out the repo and sets up Docker buildx", () => {
    expect(yaml).toContain("actions/checkout");
    expect(yaml).toContain("docker/setup-buildx-action");
  });

  it("serializes deploys per ref (concurrency) so CAS-guarded deploys don't race", () => {
    expect(yaml).toContain("concurrency:");
    expect(yaml).toContain("group: launch-pad-deploy-${{ github.ref }}");
    expect(yaml).toContain("cancel-in-progress: true");
  });

  it("allows a manual run via workflow_dispatch", () => {
    expect(yaml).toContain("workflow_dispatch:");
  });
});
