/**
 * Pure planning for `deploy --remote-build` — building a service's image on AWS
 * CodeBuild instead of local docker, for slim CI runners with no docker daemon.
 *
 * Everything here is side-effect free (names, IAM documents, the buildspec, and the
 * context-packaging rules); the AWS calls live in `../aws/codebuild.ts` and the
 * deploy wiring in `../commands/deploy.ts`.
 */

import { relative, sep } from "node:path";
import { DEFAULT_CLUSTER } from "@agentsystemlabs/launch-pad-shared";

/**
 * One CodeBuild project per cluster, reused by every remote build in it (per-build
 * parameters arrive as StartBuild env-var overrides). CodeBuild project names allow
 * only [A-Za-z0-9-_] (2–255 chars), so sanitize the cluster id.
 */
export function remoteBuildProjectName(clusterId: string): string {
  const slug = clusterId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `launch-pad-build-${slug}`.slice(0, 255);
}

/** The CodeBuild service role paired with {@link remoteBuildProjectName} (IAM caps names at 64). */
export function remoteBuildRoleName(clusterId: string): string {
  const slug = clusterId.replace(/[^a-zA-Z0-9+=,.@_-]/g, "-");
  return `launch-pad-codebuild-${slug}`.slice(0, 64);
}

/** Trust policy letting only the CodeBuild service assume the build role. */
export function codebuildTrustPolicy(): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "codebuild.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export interface CodeBuildPolicyParams {
  bucket: string;
  region: string;
  accountId: string;
  clusterId: string;
  projectName: string;
}

/**
 * Least-privilege inline policy for the CodeBuild service role: pull the uploaded
 * build context, push the result to ECR, and write its own build logs. S3 read is
 * scoped to the cluster's OWN `builds/` prefix ONLY — the build container must not
 * be able to read desired.json/status.json (they carry plaintext env vars), nor
 * another cluster's uploaded build contexts.
 */
export function buildCodeBuildServicePolicy(params: CodeBuildPolicyParams): string {
  const { bucket, region, accountId, clusterId, projectName } = params;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  // Mirrors remoteBuildContextPrefix (shared s3-keys): the default cluster's
  // footprints live at the legacy un-prefixed projects/ root.
  const buildsResource =
    clusterId === DEFAULT_CLUSTER
      ? `${bucketArn}/projects/*/builds/*`
      : `${bucketArn}/clusters/${clusterId}/projects/*/builds/*`;
  const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:/aws/codebuild/${projectName}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        // Registry-wide auth token — the API has no resource-level scope for it.
        Sid: "EcrAuth",
        Effect: "Allow",
        Action: ["ecr:GetAuthorizationToken"],
        Resource: ["*"],
      },
      {
        // Push the built image (and read back layers for cross-build layer cache hits).
        Sid: "EcrPush",
        Effect: "Allow",
        Action: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ],
        Resource: [`arn:aws:ecr:${region}:${accountId}:repository/*`],
      },
      {
        Sid: "ReadBuildContexts",
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: [buildsResource],
      },
      {
        Sid: "BuildLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: [logGroupArn, `${logGroupArn}:*`],
      },
    ],
  });
}

/**
 * The inline buildspec every remote build runs. Per-build parameters arrive as env
 * vars from StartBuild's `environmentVariablesOverride`:
 *
 *   CONTEXT_BUCKET / CONTEXT_KEY — where deploy uploaded the context tar.gz
 *   ECR_REGISTRY                 — `<acct>.dkr.ecr.<region>.amazonaws.com`
 *   IMAGE_URI                    — full immutable tag to build + push
 *   DOCKERFILE                   — context-relative dockerfile path
 *
 * `--platform linux/amd64` keeps the wire contract with nodes identical to the local
 * buildx path (nodes are x86_64); AWS_REGION is set by CodeBuild itself.
 */
export function remoteBuildSpec(): string {
  return [
    "version: 0.2",
    "phases:",
    "  pre_build:",
    "    commands:",
    '      - aws s3 cp "s3://$CONTEXT_BUCKET/$CONTEXT_KEY" /tmp/context.tar.gz',
    "      - mkdir -p /tmp/build-context && tar -xzf /tmp/context.tar.gz -C /tmp/build-context",
    '      - aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"',
    // Push lives in the SAME phase as the build: CodeBuild still runs post_build
    // after a failed build phase, and a doomed push there would bury the real error.
    // Within one phase, a failed command skips the rest.
    //
    // The build retries with backoff: CodeBuild egresses through shared NAT IPs that
    // Docker Hub aggressively 429s for anonymous base-image pulls — a transient pull
    // failure must not fail the deploy outright. (Base images on public.ecr.aws
    // avoid the limit entirely; see the docs.)
    "  build:",
    "    commands:",
    "      - |",
    "        n=0",
    '        until docker build --platform linux/amd64 -t "$IMAGE_URI" -f "/tmp/build-context/$DOCKERFILE" /tmp/build-context; do',
    "          n=$((n+1))",
    '          [ "$n" -ge 3 ] && exit 1',
    '          echo "docker build failed (attempt $n/3) — retrying in $((n*20))s (Docker Hub rate-limits CodeBuild IPs)"',
    "          sleep $((n*20))",
    "        done",
    '      - docker push "$IMAGE_URI"',
    "",
  ].join("\n");
}

/**
 * The dockerfile's context-relative posix path, or null when it lives outside the
 * context directory — a remote build ships ONLY the context tarball, so an escaping
 * dockerfile (`dockerfile = "../Dockerfile"`) can't be built remotely.
 */
export function dockerfileInContext(contextDir: string, dockerfilePath: string): string | null {
  const rel = relative(contextDir, dockerfilePath);
  if (rel === "" || rel.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

/** Strip leading `./` / `/` and any trailing `/` — .dockerignore paths are root-relative. */
function normalizePattern(line: string): string {
  return line.replace(/^\.\//, "").replace(/^\//, "").replace(/\/+$/, "");
}

/** A pattern shape {@link shouldExcludeFromContext} knows how to match. */
function isSupportedPattern(p: string): boolean {
  if (!/[*?[\]]/.test(p)) return true; // literal
  if (/^\*[A-Za-z0-9._-]+$/.test(p)) return true; // root-level `*.pem` / `*suffix`
  if (/^[A-Za-z0-9._-]+\*$/.test(p)) return true; // root-level `.env*` / `prefix*`
  if (p.startsWith("**/")) return isSupportedPattern(p.slice(3)) && !p.slice(3).includes("/"); // any-depth basename
  return false;
}

/**
 * The subset of .dockerignore we honor when packaging the context tarball: literal
 * root-relative paths, root-level `*suffix` / `prefix*` globs, and any-depth double-star (`**`-prefixed)
 * forms. This is not just an upload-size optimization — a remote build PERSISTS the
 * context to S3, so the glob patterns people guard secrets with (`*.pem`, `.env*`,
 * `**`-prefixed key globs) must keep those files out of the upload, exactly as docker keeps them
 * out of the build.
 *
 * Negations flip the priority to build correctness: a `!re-include` means docker
 * still needs files inside an excluded tree, so any exclusion a negation falls
 * under is dropped (uploaded anyway), and a wildcard negation — which we can't
 * reason about — drops every exclusion. Unsupported glob shapes are skipped too;
 * docker re-applies the full .dockerignore remotely either way, so an upload that
 * is too inclusive only costs size/confidentiality breadth, never a wrong image.
 */
export function parseDockerignore(content: string): string[] {
  const patterns: string[] = [];
  const negations: string[] = [];
  let wildcardNegation = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      const target = normalizePattern(line.slice(1));
      if (/[*?[\]]/.test(target)) wildcardNegation = true;
      else if (target !== "") negations.push(target);
      continue;
    }
    const normalized = normalizePattern(line);
    if (normalized === "" || !isSupportedPattern(normalized)) continue;
    patterns.push(normalized);
  }
  if (wildcardNegation) return [];
  const hasNegations = negations.length > 0;
  return patterns.filter((p) => {
    // With negations present, keep only literal patterns no negation re-includes under.
    if (hasNegations && /[*?[\]]/.test(p)) return false;
    return !negations.some((n) => shouldExcludeFromContext(n, [p]));
  });
}

/** Match a root-level glob of the `*suffix` / `prefix*` shapes against one name. */
function matchesSimpleGlob(name: string, pattern: string): boolean {
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Whether a context-relative posix path stays out of the uploaded tarball, with
 * docker's anchoring: a literal or root glob (`node_modules`, `*.pem`, `.env*`)
 * matches at the root only; double-star (`**`-prefixed) matches the basename (or a directory segment,
 * and everything under it) at any depth. `.git` is always excluded: it's never a
 * build input and often dwarfs the context.
 */
export function shouldExcludeFromContext(relPath: string, patterns: string[]): boolean {
  const segments = relPath.split("/");
  for (const pattern of [".git", ...patterns]) {
    if (pattern.startsWith("**/")) {
      const base = pattern.slice(3);
      if (/[*?[\]]/.test(base)) {
        // double-star extension glob: any-depth basename glob (files).
        if (matchesSimpleGlob(segments[segments.length - 1] as string, base)) return true;
      } else if (segments.includes(base)) {
        // double-star name: any-depth file or directory segment (and everything under it).
        return true;
      }
      continue;
    }
    if (/[*?[\]]/.test(pattern)) {
      // Root-level glob: applies to top-level entries only, like .dockerignore.
      if (matchesSimpleGlob(segments[0] as string, pattern) && segments.length === 1) return true;
      continue;
    }
    if (relPath === pattern || relPath.startsWith(`${pattern}/`)) return true;
  }
  return false;
}
