import { CliError } from "../errors";

/** GitHub's OIDC token issuer — the same host for every repository. */
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse a `owner/name` GitHub slug, rejecting anything that isn't exactly two path parts. */
export function parseRepo(input: string): RepoRef {
  const parts = input.split("/");
  if (parts.length !== 2) {
    throw new CliError(`invalid --repo "${input}"`, { hint: "pass it as owner/name, e.g. acme/widgets" });
  }
  const [owner, repo] = parts as [string, string];
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(repo)) {
    throw new CliError(`invalid --repo "${input}"`, {
      hint: "owner and name may contain letters, numbers, '.', '_' and '-' only",
    });
  }
  return { owner, repo };
}

/**
 * Validate a git branch name before it's interpolated into the OIDC `sub` claim. A `*`
 * or `:` here would silently widen the subject match (e.g. `refs/heads/*`), so we reject
 * anything that isn't a plain ref segment.
 */
export function validateBranch(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) {
    throw new CliError(`invalid --branch "${branch}"`, {
      hint: "use a plain branch name (letters, numbers, '.', '_', '/', '-'); no '*' or ':'",
    });
  }
  return branch;
}

/** Validate an IAM role name against IAM's allowed charset so the emitted ARN is well-formed. */
export function validateRoleName(name: string): string {
  if (!/^[\w+=,.@-]{1,64}$/.test(name)) {
    throw new CliError(`invalid --role-name "${name}"`, {
      hint: "IAM role names are 1–64 chars of [A-Za-z0-9_+=,.@-]",
    });
  }
  return name;
}

/** The OIDC provider ARN that must exist in the account (created once during setup). */
export function oidcProviderArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}`;
}

/**
 * The `sub` claim the trust policy matches. With a branch it pins to that ref so only
 * that branch's workflow can assume the role; without one it opens to any ref in the
 * repo (`repo:owner/name:*`) — still repo-scoped, but broader.
 */
export function githubSubject(ref: RepoRef & { branch?: string }): string {
  const base = `repo:${ref.owner}/${ref.repo}`;
  return ref.branch ? `${base}:ref:refs/heads/${ref.branch}` : `${base}:*`;
}

export interface OidcTrustPolicyParams {
  accountId: string;
  /** Output of {@link githubSubject}. */
  subject: string;
}

export interface OidcTrustStatement {
  Effect: "Allow";
  Principal: { Federated: string };
  Action: "sts:AssumeRoleWithWebIdentity";
  Condition: {
    StringEquals: Record<string, string>;
    StringLike: Record<string, string>;
  };
}

export interface OidcTrustPolicy {
  Version: "2012-10-17";
  Statement: OidcTrustStatement[];
}

/**
 * The IAM role trust policy for a GitHub-Actions deploy role: it federates GitHub's
 * OIDC provider, requires the `sts.amazonaws.com` audience, and pins the subject to the
 * configured repo/ref so no other repository can assume the role.
 */
export function buildOidcTrustPolicy(params: OidcTrustPolicyParams): OidcTrustPolicy {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: oidcProviderArn(params.accountId) },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com" },
          StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: params.subject },
        },
      },
    ],
  };
}

export function oidcTrustPolicyJson(params: OidcTrustPolicyParams): string {
  return `${JSON.stringify(buildOidcTrustPolicy(params), null, 2)}\n`;
}

export interface DeployWorkflowParams {
  roleArn: string;
  region: string;
  branch: string;
}

/**
 * A ready-to-commit `.github/workflows/deploy.yml`: assume the deploy role via OIDC
 * (no long-lived keys), set up Docker buildx, then run a non-interactive deploy.
 */
export function buildDeployWorkflow(params: DeployWorkflowParams): string {
  return `name: Deploy

on:
  push:
    branches: [ ${params.branch} ]
  workflow_dispatch: {}   # allow manual runs from the Actions tab

# Required for the OIDC token exchange with AWS.
permissions:
  id-token: write
  contents: read

# Launch Pad's deploy is CAS-guarded against concurrent writers — run one deploy per
# branch at a time and cancel a superseded run rather than race it.
concurrency:
  group: launch-pad-deploy-${"${{ github.ref }}"}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${params.roleArn}
          aws-region: ${params.region}

      - uses: docker/setup-buildx-action@v3

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          # If your repo has a package-lock.json, uncomment to cache the npm download:
          # cache: npm

      # Pin the CLI version for reproducible deploys, e.g. @agentsystemlabs/launch-pad@1.2.3
      - run: npx --yes @agentsystemlabs/launch-pad deploy --yes
`;
}
