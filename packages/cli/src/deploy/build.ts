import { execa } from "execa";
import { type EcrAuth, registryHost } from "../aws/ecr";
import { CliError } from "../errors";

const BUILDER_NAME = "launchpad-builder";
const DOCKER_PROBE_TIMEOUT_MS = 15_000;
const DOCKER_LOGIN_TIMEOUT_MS = 30_000;

function isTimedOut(error: unknown): boolean {
  return (error as { timedOut?: boolean }).timedOut === true;
}

function errorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  if (stderr) return stderr;
  return (error as Error).message || "unknown error";
}

function dockerDaemonTimeoutError(action: string): CliError {
  return new CliError(`Docker did not respond while ${action}`, {
    hint: [
      "Docker Desktop appears to be running but its daemon is not answering CLI requests.",
      "Restart Docker Desktop, then verify `docker info` returns before retrying deploy.",
      "You can avoid local Docker with `launchpad deploy --remote-build --yes`.",
    ].join("\n"),
  });
}

/** Verify docker + buildx are available before we rely on them. */
export async function checkDocker(): Promise<void> {
  try {
    await execa("docker", ["buildx", "version"], { timeout: DOCKER_PROBE_TIMEOUT_MS });
  } catch (error) {
    if (isTimedOut(error)) throw dockerDaemonTimeoutError("checking buildx");
    throw new CliError("docker with buildx is required but was not found", {
      hint: "install Docker Desktop (or docker + buildx) and make sure the daemon is running",
    });
  }
  try {
    await execa("docker", ["info"], { timeout: DOCKER_PROBE_TIMEOUT_MS });
  } catch (error) {
    if (isTimedOut(error)) throw dockerDaemonTimeoutError("checking the Docker daemon");
    throw new CliError("Docker daemon is not available", {
      hint: errorDetail(error),
    });
  }
}

/**
 * Compute an immutable image tag for a build context. A clean git checkout yields
 * the short commit sha; a dirty tree (or no git) yields a unique dev tag, so we
 * never try to overwrite an existing immutable tag.
 */
export async function computeImageTag(contextDir: string): Promise<string> {
  try {
    const sha = (await execa("git", ["rev-parse", "--short=12", "HEAD"], { cwd: contextDir })).stdout.trim();
    const status = (await execa("git", ["status", "--porcelain"], { cwd: contextDir })).stdout.trim();
    if (status.length === 0) return sha;
    return `${sha}-dev-${Date.now().toString(36)}`;
  } catch {
    return `dev-${Date.now().toString(36)}`;
  }
}

/** Ensure a docker-container buildx builder exists (needed for cross-arch --push). */
export async function ensureBuilder(): Promise<void> {
  try {
    await execa("docker", ["buildx", "inspect", BUILDER_NAME], { timeout: DOCKER_PROBE_TIMEOUT_MS });
  } catch (error) {
    if (isTimedOut(error)) throw dockerDaemonTimeoutError(`inspecting buildx builder "${BUILDER_NAME}"`);
    try {
      await execa(
        "docker",
        [
          "buildx",
          "create",
          "--name",
          BUILDER_NAME,
          "--driver",
          "docker-container",
        ],
        { timeout: DOCKER_PROBE_TIMEOUT_MS },
      );
    } catch (createError) {
      if (isTimedOut(createError)) throw dockerDaemonTimeoutError(`creating buildx builder "${BUILDER_NAME}"`);
      throw new CliError(`could not create buildx builder "${BUILDER_NAME}"`, {
        hint: errorDetail(createError),
      });
    }
  }
}

export async function dockerLoginEcr(auth: EcrAuth): Promise<void> {
  try {
    await execa(
      "docker",
      ["login", "--username", auth.username, "--password-stdin", registryHost(auth.endpoint)],
      { input: auth.password, timeout: DOCKER_LOGIN_TIMEOUT_MS },
    );
  } catch (error) {
    if (isTimedOut(error)) throw dockerDaemonTimeoutError("logging in to ECR");
    throw new CliError(`docker login to ECR failed: ${errorDetail(error)}`);
  }
}

export interface BuildArgs {
  contextDir: string;
  dockerfile: string;
  imageUri: string;
  verbose?: boolean;
}

/** Build for linux/amd64 and push to ECR in a single step. */
export async function buildAndPush(args: BuildArgs): Promise<void> {
  const cmd = [
    "buildx",
    "build",
    "--builder",
    BUILDER_NAME,
    "--platform",
    "linux/amd64",
    "-f",
    args.dockerfile,
    "-t",
    args.imageUri,
    "--push",
    args.contextDir,
  ];
  try {
    await execa("docker", cmd, { stdio: args.verbose ? "inherit" : "pipe" });
  } catch (error) {
    throw new CliError(`docker build/push failed for ${args.imageUri}`, {
      hint: errorDetail(error).split("\n").slice(-6).join("\n"),
    });
  }
}
