import { execa } from "execa";
import { type EcrAuth, registryHost } from "../aws/ecr";
import { CliError } from "../errors";

const BUILDER_NAME = "launchpad-builder";

/** Verify docker + buildx are available before we rely on them. */
export async function checkDocker(): Promise<void> {
  try {
    await execa("docker", ["buildx", "version"]);
  } catch {
    throw new CliError("docker with buildx is required but was not found", {
      hint: "install Docker Desktop (or docker + buildx) and make sure the daemon is running",
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
    await execa("docker", ["buildx", "inspect", BUILDER_NAME]);
  } catch {
    await execa("docker", [
      "buildx",
      "create",
      "--name",
      BUILDER_NAME,
      "--driver",
      "docker-container",
    ]);
  }
}

export async function dockerLoginEcr(auth: EcrAuth): Promise<void> {
  try {
    await execa(
      "docker",
      ["login", "--username", auth.username, "--password-stdin", registryHost(auth.endpoint)],
      { input: auth.password },
    );
  } catch (error) {
    throw new CliError(`docker login to ECR failed: ${(error as Error).message}`);
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
    const detail =
      (error as { stderr?: string }).stderr || (error as Error).message || "unknown error";
    throw new CliError(`docker build/push failed for ${args.imageUri}`, {
      hint: detail.split("\n").slice(-6).join("\n"),
    });
  }
}
