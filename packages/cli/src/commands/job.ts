import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  type JobDecl,
  type NodeStatus,
  type ServiceConfig,
  containerEnvForDeploy,
  desiredKey,
  dockerPlatformForArchitecture,
  ecrRepositoryName,
  findEnvSecretConflicts,
  emptyDesiredState,
  footprintOwner,
  mergeProjectServicesPartial,
  nodeRegistryKey,
  parseDesiredStateOrEmpty,
  parseNodeRegistryEntry,
  parseNodeStatus,
  remoteBuildContextKey,
  secretRefsForService,
  secretParameterPath,
  statusKey,
  type NodeRegistryEntry,
} from "@agentsystemlabs/launch-pad-shared";
import { prepareAws, type AwsEnv } from "../aws/context";
import {
  createCodeBuildClient,
  deleteBuildContext,
  ensureRemoteBuildInfra,
  runRemoteBuild,
  uploadBuildContext,
} from "../aws/codebuild";
import { getEcrAuth, imageExists, ensureRepository } from "../aws/ecr";
import { getExistingSecretPaths } from "../aws/ssm-secrets";
import { getJson, PreconditionFailedError, putJson } from "../aws/s3-state";
import { checkDocker, computeImageTag, dockerLoginEcr, ensureBuilder, buildAndPush } from "../deploy/build";
import { packBuildContext } from "../deploy/context-pack";
import { loadDeployedPlacement } from "../deploy/deployed-footprint";
import { dockerfileInContext } from "../deploy/remote-build";
import { loadConfig } from "../config/load";
import { CliError } from "../errors";
import { resolveTimeoutSecondsMs } from "../timeout";
import { applyGlobalOptions, mergedOpts, type GlobalOpts } from "../globals";
import { isJsonMode, log, printJson, spinner } from "../ui/log";
import { color } from "../ui/theme";

const DEFAULT_JOB_TIMEOUT_SECONDS = 300;
const MAX_PUBLISH_RETRIES = 5;

interface JobRunOptions extends GlobalOpts {
  env?: string;
  wait?: boolean;
  timeout?: string;
  yes?: boolean;
  remoteBuild?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function assertJobSecretsPresent(aws: AwsEnv, job: JobDecl, ownerProject: string): Promise<void> {
  if (job.secrets.length === 0) return;
  const paths = job.secrets.map((key) =>
    secretParameterPath({ clusterId: aws.clusterId, ownerProject, service: job.name, key }),
  );
  const found = await getExistingSecretPaths(aws.ssm, paths);
  const missing = job.secrets.filter((key) =>
    !found.has(secretParameterPath({ clusterId: aws.clusterId, ownerProject, service: job.name, key })),
  );
  if (missing.length > 0) {
    throw new CliError(`missing SSM secrets: ${missing.map((k) => `${job.name}/${k}`).join(", ")}`, {
      hint: "set them with `launchpad secret set <KEY> --service <job-name>`",
    });
  }
}

async function chooseJobNode(aws: AwsEnv, ownerProject: string): Promise<string> {
  const placement = await loadDeployedPlacement(aws.s3, aws.bucket, aws.clusterId, ownerProject);
  const database = placement.footprints.find((f) => f.database !== undefined);
  if (database) {
    if (database.nodeIds.length === 1) return database.nodeIds[0] as string;
    throw new CliError(`database service "${database.service}" is published on multiple nodes`, {
      hint: "managed databases should be sticky on one node; inspect desired.json before running the job",
    });
  }
  if (placement.occupiedNodeIds.length === 1) return placement.occupiedNodeIds[0] as string;
  if (placement.occupiedNodeIds.length === 0) {
    throw new CliError("no deployed services found for this footprint", {
      hint: "deploy the database or another service first, e.g. `launchpad deploy --service primary --yes`",
    });
  }
  throw new CliError("could not choose a job node automatically", {
    hint: "deploy the database first so the job can run on the database's sticky node",
  });
}

async function loadNode(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
  if (!obj) throw new CliError(`node "${nodeId}" not found`);
  return parseNodeRegistryEntry(obj.raw);
}

function toJobServiceConfig(
  aws: AwsEnv,
  ownerProject: string,
  job: JobDecl,
  image: string,
  runId: string,
  requestedAt: string,
  env: string | undefined,
): ServiceConfig {
  return {
    project: ownerProject,
    service: job.name,
    image,
    cpu: job.cpu,
    memory: job.memory,
    replicas: 1,
    env: containerEnvForDeploy(job.env, env),
    secretRefs: secretRefsForService(job.secrets, {
      clusterId: aws.clusterId,
      ownerProject,
      service: job.name,
    }),
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
    jobRun: { id: runId, requestedAt },
  };
}

async function publishJobRun(aws: AwsEnv, nodeId: string, incoming: ServiceConfig): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
    const state = existing
      ? parseDesiredStateOrEmpty(nodeId, existing.raw, nowIso())
      : emptyDesiredState(nodeId, nowIso());
    const current = state.services.find((s) => s.project === incoming.project && s.service === incoming.service);
    if (current?.jobRun && current.jobRun.id !== incoming.jobRun?.id) {
      throw new CliError(`job "${incoming.service}" is already running`, {
        hint: `wait for run ${current.jobRun.id} to finish before starting another`,
      });
    }
    const merged = mergeProjectServicesPartial(state.services, incoming.project, [incoming]);
    try {
      await putJson(
        aws.s3,
        aws.bucket,
        desiredKey(aws.clusterId, nodeId),
        { version: state.version, nodeId, updatedAt: nowIso(), services: merged },
        { ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }) },
      );
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  throw new CliError(`could not publish job run to node "${nodeId}"`, {
    hint: "another deploy may be racing this node — try again",
  });
}

async function removeJobRun(aws: AwsEnv, nodeId: string, ownerProject: string, jobName: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_PUBLISH_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, desiredKey(aws.clusterId, nodeId));
    if (!existing) return;
    const state = parseDesiredStateOrEmpty(nodeId, existing.raw, nowIso());
    const services = state.services.filter((s) => !(s.project === ownerProject && s.service === jobName && s.jobRun?.id === runId));
    if (services.length === state.services.length) return;
    try {
      await putJson(
        aws.s3,
        aws.bucket,
        desiredKey(aws.clusterId, nodeId),
        { version: state.version, nodeId, updatedAt: nowIso(), services },
        { ifMatch: existing.etag },
      );
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  throw new CliError(`could not remove job run from node "${nodeId}"`, {
    hint: "another deploy may be racing this node — try again",
  });
}

function jobStatus(status: NodeStatus | null, ownerProject: string, jobName: string, runId: string) {
  return status?.services.find((s) => s.project === ownerProject && s.service === jobName && s.jobRun?.id === runId)?.jobRun ?? null;
}

interface JobWaitOutcome {
  ok: boolean;
  exitCode: number | null;
  message: string;
}

async function waitForJob(aws: AwsEnv, nodeId: string, ownerProject: string, jobName: string, runId: string, timeoutMs: number): Promise<JobWaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, nodeId));
    let status: NodeStatus | null = null;
    if (obj) {
      try {
        status = parseNodeStatus(obj.raw);
      } catch {
        status = null;
      }
    }
    const run = jobStatus(status, ownerProject, jobName, runId);
    if (run?.state === "succeeded") return { ok: true, exitCode: run.exitCode, message: run.message };
    if (run?.state === "failed") {
      return { ok: false, exitCode: run.exitCode, message: run.message };
    }
    if (Date.now() > deadline) {
      throw new CliError(`timed out waiting for job "${jobName}"`, {
        hint: "check node status or logs, then retry the job",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function runJob(name: string, opts: JobRunOptions): Promise<void> {
  const { config, dir } = loadConfig();
  const job = (config.job ?? []).find((j) => j.name === name);
  if (!job) {
    throw new CliError(`no job named "${name}" in launch-pad.toml`, {
      hint: `available jobs: ${(config.job ?? []).map((j) => j.name).join(", ") || "(none)"}`,
    });
  }

  const aws = await prepareAws(opts, { ensureBucket: true });
  const ownerProject = footprintOwner(config, opts.env);
  const conflicts = findEnvSecretConflicts(job.env, job.secrets);
  if (conflicts.length > 0) {
    throw new CliError(`job "${job.name}" declares a key in both env and secrets: ${conflicts.join(", ")}`, {
      hint: "keep secret values in SSM only; remove the duplicate key from [job.env]",
    });
  }
  await assertJobSecretsPresent(aws, job, ownerProject);

  const nodeId = await chooseJobNode(aws, ownerProject);
  const node = await loadNode(aws, nodeId);
  if (node.role !== "app") {
    throw new CliError(`job target "${nodeId}" is not an app node`);
  }

  const repoName = ecrRepositoryName(config.project, job.name);
  const contextDir = resolve(dir, job.context);
  const dockerfilePath = resolve(dir, job.dockerfile);
  const repoUri = await ensureRepository(aws.ecr, repoName, { project: config.project, service: job.name });
  const tag = await computeImageTag(contextDir);
  const image = `${repoUri}:${tag}`;

  if (!(await imageExists(aws.ecr, repoName, tag))) {
    const platform = dockerPlatformForArchitecture(node.architecture);
    if (opts.remoteBuild) {
      const codebuild = createCodeBuildClient(aws.region);
      const infra = spinner("ensuring the cluster's CodeBuild project…").start();
      let projectName: string;
      try {
        ({ projectName } = await ensureRemoteBuildInfra(codebuild, aws.iam, {
          clusterId: aws.clusterId,
          bucket: aws.bucket,
          region: aws.region,
          accountId: aws.accountId,
        }));
        infra.succeed("CodeBuild project ready");
      } catch (error) {
        infra.fail("CodeBuild project setup failed");
        throw error;
      }

      const dockerfile = dockerfileInContext(contextDir, dockerfilePath);
      if (!dockerfile) {
        throw new CliError(`job "${job.name}" dockerfile must be inside its build context for --remote-build`, {
          hint: `context: ${contextDir}\ndockerfile: ${dockerfilePath}`,
        });
      }
      const packed = await packBuildContext(contextDir, { alwaysInclude: [dockerfile] });
      const contextKey = remoteBuildContextKey(aws.clusterId, ownerProject, job.name, tag);
      const spin = spinner(`remote building job ${job.name} → ${tag} (${platform})`).start();
      try {
        spin.text = `uploading build context for ${job.name}…`;
        await uploadBuildContext(aws.s3, aws.bucket, contextKey, packed.file, packed.bytes);
        await runRemoteBuild(codebuild, aws.logs, {
          projectName,
          contextBucket: aws.bucket,
          contextKey,
          imageUri: image,
          dockerfile,
          platform,
          ecrRegistry: `${aws.accountId}.dkr.ecr.${aws.region}.amazonaws.com`,
          onProgress: (text) => {
            spin.text = `${job.name}: ${text}`;
          },
        });
        spin.succeed(`remote built + pushed ${color.cyan(job.name)} → ${color.dim(tag)}`);
      } catch (error) {
        spin.fail(`remote build failed for job ${job.name}`);
        throw error;
      } finally {
        await deleteBuildContext(aws.s3, aws.bucket, contextKey);
        rmSync(packed.file, { force: true });
      }
    } else {
      const prep = spinner("preparing local Docker build environment…").start();
      try {
        await checkDocker();
        await ensureBuilder();
        prep.text = "logging in to ECR…";
        await dockerLoginEcr(await getEcrAuth(aws.ecr));
        prep.succeed("Docker builder ready");
      } catch (error) {
        if (prep.isSpinning) prep.fail("Docker build environment is not ready");
        throw error;
      }
      const spin = spinner(`building job ${job.name} → ${tag} (${platform})`).start();
      try {
        await buildAndPush({ contextDir, dockerfile: dockerfilePath, imageUri: image, platform, verbose: opts.verbose });
        spin.succeed(`built + pushed ${color.cyan(job.name)} → ${color.dim(tag)}`);
      } catch (error) {
        spin.fail(`build failed for job ${job.name}`);
        throw error;
      }
    }
  }

  const runId = randomUUID();
  const requestedAt = nowIso();
  const jobConfig = toJobServiceConfig(aws, ownerProject, job, image, runId, requestedAt, opts.env);
  await publishJobRun(aws, nodeId, jobConfig);
  log.success(`published job run ${color.cyan(job.name)} → ${color.cyan(nodeId)}`);

  if (opts.wait === false) {
    if (isJsonMode()) printJson({ job: job.name, runId, nodeId, image, status: "published" });
    return;
  }

  const spin = spinner(`waiting for job ${job.name}…`).start();
  let terminal = false;
  try {
    const outcome = await waitForJob(
      aws,
      nodeId,
      ownerProject,
      job.name,
      runId,
      resolveTimeoutSecondsMs(opts.timeout, DEFAULT_JOB_TIMEOUT_SECONDS),
    );
    terminal = true;
    if (!outcome.ok) {
      spin.fail(`job ${job.name} failed`);
      throw new CliError(`job "${job.name}" failed${outcome.exitCode !== null ? ` (exit ${outcome.exitCode})` : ""}`, {
        hint: outcome.message || "check `launchpad logs` for the job output",
      });
    }
    spin.succeed(`job ${color.cyan(job.name)} succeeded`);
    if (isJsonMode()) printJson({ job: job.name, runId, nodeId, image, status: "succeeded" });
  } finally {
    if (terminal) await removeJobRun(aws, nodeId, ownerProject, job.name, runId);
  }
}

export function registerJob(program: Command): void {
  const job = program.command("job").description("Run one-off jobs declared in launch-pad.toml");

  const run = job
    .command("run <name>")
    .description("Build and run one [[job]] once on the deployed app node")
    .option("--env <name>", "run against a named environment footprint")
    .option("--wait", "wait for the job to finish (default)")
    .option("--no-wait", "don't wait for the job to finish")
    .option("--timeout <seconds>", "how long to wait for completion", String(DEFAULT_JOB_TIMEOUT_SECONDS))
    .option("--yes", "skip confirmation prompts (reserved for CI symmetry)")
    .option("--remote-build", "build images on AWS CodeBuild instead of local docker")
    .addHelpText(
      "after",
      [
        "",
        "Jobs are not part of normal `deploy`; they run only when requested.",
        "For migrations, deploy the database first, then run the job, then deploy the API:",
        "  $ launchpad deploy --service primary --yes",
        "  $ launchpad job run migrate --wait --yes",
        "  $ launchpad deploy --service api --yes",
      ].join("\n"),
    )
    .action(async (name: string, _opts, command: Command) => {
      await runJob(name, mergedOpts<JobRunOptions>(command));
    });

  applyGlobalOptions(run);
}
