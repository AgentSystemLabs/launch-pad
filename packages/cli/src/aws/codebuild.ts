/**
 * CodeBuild side of `deploy --remote-build`: one per-cluster build project (plus its
 * least-privilege service role) that builds a service's docker image from an uploaded
 * context tarball and pushes it to ECR — no local docker daemon required.
 *
 * The pure planning (names, policy documents, the buildspec) lives in
 * `../deploy/remote-build.ts`; this module is the side-effecting AWS half.
 */

import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  CreateProjectCommand,
  DeleteProjectCommand,
  StartBuildCommand,
  UpdateProjectCommand,
} from "@aws-sdk/client-codebuild";
import {
  DeleteLogGroupCommand,
  GetLogEventsCommand,
  type CloudWatchLogsClient,
} from "@aws-sdk/client-cloudwatch-logs";
import { createReadStream } from "node:fs";
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  type IAMClient,
  PutRolePolicyCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import { AWS_TAG_CLUSTER, managedTag } from "@agentsystemlabs/launch-pad-shared";
import {
  buildCodeBuildServicePolicy,
  codebuildTrustPolicy,
  remoteBuildProjectName,
  remoteBuildRoleName,
  remoteBuildSpec,
} from "../deploy/remote-build";
import { CliError } from "../errors";
import { awsErrorName } from "./errors";

const ROLE_POLICY_NAME = "launch-pad-codebuild-policy";

/** Hard ceiling on one remote build (CodeBuild's own queue + provisioning included). */
const BUILD_TIMEOUT_MINUTES = 30;
const POLL_INTERVAL_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createCodeBuildClient(region: string): CodeBuildClient {
  return new CodeBuildClient({ region });
}

function isAlreadyExists(error: unknown): boolean {
  const name = awsErrorName(error);
  return (
    name === "EntityAlreadyExists" ||
    name === "EntityAlreadyExistsException" ||
    name === "ResourceAlreadyExists" ||
    name === "ResourceAlreadyExistsException"
  );
}

function isNotFound(error: unknown): boolean {
  const name = awsErrorName(error);
  return (
    name === "ResourceNotFound" ||
    name === "ResourceNotFoundException" ||
    name === "NoSuchEntity" ||
    name === "NoSuchEntityException"
  );
}

export interface RemoteBuildInfraParams {
  clusterId: string;
  bucket: string;
  region: string;
  accountId: string;
}

/**
 * Idempotently ensure the cluster's CodeBuild project + service role. Always
 * re-puts the role policy and re-applies the project settings, so an upgraded CLI
 * converges existing infra (e.g. a new buildspec) instead of running a stale one.
 */
export async function ensureRemoteBuildInfra(
  codebuild: CodeBuildClient,
  iam: IAMClient,
  params: RemoteBuildInfraParams,
): Promise<{ projectName: string }> {
  const roleName = remoteBuildRoleName(params.clusterId);
  const projectName = remoteBuildProjectName(params.clusterId);
  const roleArn = `arn:aws:iam::${params.accountId}:role/${roleName}`;

  try {
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(codebuildTrustPolicy()),
        Description: `launchpad remote-build service role for cluster ${params.clusterId}`,
      }),
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: ROLE_POLICY_NAME,
      PolicyDocument: buildCodeBuildServicePolicy({
        bucket: params.bucket,
        region: params.region,
        accountId: params.accountId,
        clusterId: params.clusterId,
        projectName,
      }),
    }),
  );
  try {
    await iam.send(
      new TagRoleCommand({
        RoleName: roleName,
        Tags: [managedTag(), { Key: AWS_TAG_CLUSTER, Value: params.clusterId }],
      }),
    );
  } catch {
    // Tags are hygiene, not behavior — never fail a build over them.
  }

  const projectConfig = {
    name: projectName,
    description: `launchpad remote builds for cluster ${params.clusterId} (deploy --remote-build)`,
    // NO_SOURCE: the buildspec downloads the context tarball from S3 itself, so we
    // never need CodeBuild's zip-only S3 source type.
    source: { type: "NO_SOURCE" as const, buildspec: remoteBuildSpec() },
    artifacts: { type: "NO_ARTIFACTS" as const },
    environment: {
      type: "LINUX_CONTAINER" as const,
      image: "aws/codebuild/standard:7.0",
      computeType: "BUILD_GENERAL1_SMALL" as const,
      // Required for a docker daemon inside the build container.
      privilegedMode: true,
    },
    serviceRole: roleArn,
    timeoutInMinutes: BUILD_TIMEOUT_MINUTES,
    tags: [
      { key: managedTag().Key, value: managedTag().Value },
      { key: AWS_TAG_CLUSTER, value: params.clusterId },
    ],
  };

  // A freshly created IAM role can take a few seconds to become assumable by
  // CodeBuild; CreateProject validates it and fails with InvalidInputException
  // until propagation completes — retry instead of surfacing a transient error.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await codebuild.send(new CreateProjectCommand(projectConfig));
      return { projectName };
    } catch (error) {
      if (isAlreadyExists(error)) {
        await codebuild.send(new UpdateProjectCommand(projectConfig));
        return { projectName };
      }
      if (awsErrorName(error) === "InvalidInputException" && attempt < 10) {
        await sleep(3_000);
        continue;
      }
      throw error;
    }
  }
}

/** Upload a packed context tarball to the state bucket for CodeBuild to download. */
export async function uploadBuildContext(
  s3: S3Client,
  bucket: string,
  key: string,
  file: string,
  bytes: number,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(file),
      ContentLength: bytes,
      ContentType: "application/gzip",
    }),
  );
}

/** Remove an uploaded context tarball once its build finished (best-effort). */
export async function deleteBuildContext(s3: S3Client, bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // Best-effort: a leftover tarball costs pennies and `cluster destroy` sweeps it.
  }
}

export interface RemoteBuildParams {
  projectName: string;
  contextBucket: string;
  contextKey: string;
  imageUri: string;
  /** Context-relative dockerfile path inside the uploaded tarball. */
  dockerfile: string;
  /** `<acct>.dkr.ecr.<region>.amazonaws.com` — the registry docker login targets. */
  ecrRegistry: string;
  onProgress?: (text: string) => void;
}

/**
 * The lines of a failed build's CloudWatch log that explain the failure
 * (best-effort). The literal tail is useless — CodeBuild appends a page of
 * UPLOAD_ARTIFACTS chatter after the failing command — so anchor on the last
 * "Command did not exit successfully" marker and return the context BEFORE it
 * (the actual docker/aws error output).
 */
async function buildLogTail(
  logs: CloudWatchLogsClient,
  groupName: string | undefined,
  streamName: string | undefined,
): Promise<string[]> {
  if (!groupName || !streamName) return [];
  try {
    const res = await logs.send(
      new GetLogEventsCommand({
        logGroupName: groupName,
        logStreamName: streamName,
        limit: 150,
        startFromHead: false,
      }),
    );
    const lines = (res.events ?? [])
      .map((e) => (e.message ?? "").trimEnd())
      .filter((m) => m !== "");
    const failedAt = lines.findLastIndex((l) => l.includes("Command did not exit successfully"));
    if (failedAt > 0) return lines.slice(Math.max(0, failedAt - 15), failedAt + 1);
    return lines.slice(-12);
  } catch {
    return [];
  }
}

/**
 * Start one remote build and wait for it to finish; throws a CliError carrying the
 * build's log tail when it fails. Returns the CodeBuild build id on success.
 */
export async function runRemoteBuild(
  codebuild: CodeBuildClient,
  logs: CloudWatchLogsClient,
  params: RemoteBuildParams,
): Promise<string> {
  const started = await codebuild.send(
    new StartBuildCommand({
      projectName: params.projectName,
      environmentVariablesOverride: [
        { name: "CONTEXT_BUCKET", value: params.contextBucket },
        { name: "CONTEXT_KEY", value: params.contextKey },
        { name: "IMAGE_URI", value: params.imageUri },
        { name: "DOCKERFILE", value: params.dockerfile },
        { name: "ECR_REGISTRY", value: params.ecrRegistry },
      ],
    }),
  );
  const buildId = started.build?.id;
  if (!buildId) {
    throw new CliError("CodeBuild did not return a build id", {
      hint: "check the CodeBuild console for the launchpad build project",
    });
  }

  const deadline = Date.now() + BUILD_TIMEOUT_MINUTES * 60_000;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const res = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = res.builds?.[0];
    const status = build?.buildStatus ?? "IN_PROGRESS";
    if (status === "IN_PROGRESS") {
      params.onProgress?.(`remote build ${build?.currentPhase?.toLowerCase() ?? "queued"}…`);
      if (Date.now() > deadline) {
        throw new CliError(`remote build timed out after ${BUILD_TIMEOUT_MINUTES} minutes`, {
          hint: `inspect build ${buildId} in the CodeBuild console`,
        });
      }
      continue;
    }
    if (status === "SUCCEEDED") return buildId;

    const tail = await buildLogTail(
      logs,
      build?.logs?.groupName,
      build?.logs?.streamName,
    );
    throw new CliError(`remote build failed (${status}) for ${params.imageUri}`, {
      hint:
        tail.length > 0 ? tail.join("\n") : `inspect build ${buildId} in the CodeBuild console`,
    });
  }
}

/**
 * Best-effort teardown of the cluster's remote-build infra (project + service role
 * + the project's CloudWatch log group). Used by `cluster destroy`; tolerant of
 * anything already gone or never created.
 */
export async function deleteRemoteBuildInfra(
  codebuild: CodeBuildClient,
  iam: IAMClient,
  logs: CloudWatchLogsClient,
  clusterId: string,
): Promise<void> {
  const ignoreMissing = async (op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };
  await ignoreMissing(() =>
    codebuild.send(new DeleteProjectCommand({ name: remoteBuildProjectName(clusterId) })),
  );
  await ignoreMissing(() =>
    iam.send(
      new DeleteRolePolicyCommand({
        RoleName: remoteBuildRoleName(clusterId),
        PolicyName: ROLE_POLICY_NAME,
      }),
    ),
  );
  await ignoreMissing(() =>
    iam.send(new DeleteRoleCommand({ RoleName: remoteBuildRoleName(clusterId) })),
  );
  await ignoreMissing(() =>
    logs.send(
      new DeleteLogGroupCommand({
        logGroupName: `/aws/codebuild/${remoteBuildProjectName(clusterId)}`,
      }),
    ),
  );
}
