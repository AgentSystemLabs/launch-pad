import { Command } from "commander";
import {
  ecrRepositoryName,
  footprintOwner,
  findPreviousImageTag,
  type ImageTagPushedAt,
  LABEL_REGEX,
  parseEcrImageUri,
} from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { listRepoImageTags } from "../aws/ecr";
import { findConfigPath, loadConfig } from "../config/load";
import { loadNodeDesiredStates } from "../deploy/deployed-footprint";
import { type DeployOptions, runDeploy } from "./deploy";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

export interface RollbackOptions extends GlobalOpts {
  service?: string;
  env?: string;
  /** Explicit tag to roll back (or forward) to, instead of the previous build. */
  to?: string;
  yes?: boolean;
  /** commander sets this false for `--no-wait`. */
  wait?: boolean;
  timeout?: string;
  dryRun?: boolean;
}

export interface RollbackResolution {
  /** The tag currently deployed. */
  fromTag: string;
  /** The tag to deploy. */
  toTag: string;
  /** The full ECR image URI to publish (passed to `deploy --image`). */
  uri: string;
  /** True when the target equals the current tag — nothing to do. */
  noop: boolean;
}

/**
 * Decide which tag to roll a service to, purely from its current image + the repo's tags.
 * `toTag` (from --to) wins; otherwise the most-recent build strictly older than the current
 * one. Throws a CliError when there's nothing older (and no --to). No AWS.
 */
export function resolveRollback(
  currentImage: string,
  images: readonly ImageTagPushedAt[],
  toTag: string | undefined,
): RollbackResolution {
  const parsed = parseEcrImageUri(currentImage);
  if (!parsed) {
    throw new CliError(`couldn't parse the current image "${currentImage}"`, {
      hint: "the service's published image isn't a tagged ECR URI — roll back manually with `deploy --image`",
    });
  }

  let target: string | null | undefined = toTag;
  if (target === undefined) {
    target = findPreviousImageTag(images, parsed.tag);
    if (!target) {
      throw new CliError(`no older image to roll back "${parsed.repository}" to`, {
        hint: "this is already the oldest build — pass --to <tag> to deploy a specific one",
      });
    }
  }

  return {
    fromTag: parsed.tag,
    toTag: target,
    uri: `${parsed.registry}/${parsed.repository}:${target}`,
    noop: target === parsed.tag,
  };
}

export async function runRollback(opts: RollbackOptions): Promise<void> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run rollback from your project directory (or a parent)",
    });
  }
  const { config } = loadConfig();

  const env = opts.env;
  if (env !== undefined && !LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const ownerProject = footprintOwner(config, env);

  // Resolve the target service (required unless the project has exactly one).
  let serviceName = opts.service;
  if (!serviceName) {
    if (config.service.length === 1) serviceName = config.service[0]!.name;
    else
      throw new CliError("--service is required when launch-pad.toml has multiple services", {
        hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
      });
  }
  if (!config.service.some((s) => s.name === serviceName)) {
    throw new CliError(`no service named "${serviceName}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }

  if (opts.to !== undefined && opts.to.length === 0) {
    throw new CliError("--to needs a tag", { hint: "e.g. --to sha-abc123" });
  }

  const aws = await prepareAws(opts);

  // The service's currently-published image (consistent across replicas — take the first).
  const states = await loadNodeDesiredStates(aws.s3, aws.bucket, aws.clusterId);
  const current = states
    .flatMap((s) => s.services)
    .find((s) => s.project === ownerProject && s.service === serviceName);
  if (!current) {
    throw new CliError(`service "${serviceName}" is not deployed for "${ownerProject}"`, {
      hint: "deploy it first — there's nothing to roll back",
    });
  }

  // Only fetch the repo's tag history when we need to auto-pick the previous one.
  const images =
    opts.to === undefined
      ? await listRepoImageTags(aws.ecr, ecrRepositoryName(config.project, serviceName))
      : [];
  const res = resolveRollback(current.image, images, opts.to);

  if (res.noop) {
    if (isJsonMode()) {
      printJson({ rolledBack: false, reason: "already-on-tag", service: serviceName, tag: res.toTag });
      return;
    }
    log.info(`service ${color.cyan(serviceName)} is already running tag ${color.cyan(res.toTag)} — nothing to roll back`);
    return;
  }

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({ dryRun: true, service: serviceName, from: res.fromTag, to: res.toTag, image: res.uri });
    } else {
      log.step(`would roll ${color.cyan(serviceName)} from ${color.dim(res.fromTag)} → ${color.cyan(res.toTag)}`);
    }
    return;
  }

  if (!isJsonMode()) {
    log.step(`rolling ${color.cyan(serviceName)} ${color.dim(res.fromTag)} → ${color.cyan(res.toTag)}`);
  }
  if (opts.yes !== true && !isJsonMode()) {
    const ok = await confirm(`roll back ${color.cyan(serviceName)} to ${color.cyan(res.toTag)}?`, false);
    if (!ok) throw new CliError("aborted", { hint: "re-run with --yes to skip this prompt" });
  }

  // Delegate to the deploy --image path: it re-validates the image (own account/repo + exists),
  // pins to the published placement, and rolls health-gated to convergence.
  const deployOpts: DeployOptions = {
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.cluster !== undefined ? { cluster: opts.cluster } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    service: serviceName,
    image: res.uri,
    yes: true, // already confirmed above (or --yes / JSON mode)
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  };
  await runDeploy(deployOpts);
}

export function registerRollback(program: Command): void {
  const cmd = program
    .command("rollback")
    .description("Redeploy a service's previous image (or a specific --to tag) — health-gated")
    .option("--service <name>", "service to roll back (required when the project has multiple)")
    .option("--to <tag>", "roll to a specific immutable tag instead of the previous build")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--no-wait", "don't wait for the agent to report convergence")
    .option("--timeout <seconds>", "how long to wait for convergence")
    .option("--dry-run", "show the from → to roll without deploying")
    .option("--yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      [
        "",
        "Rollback redeploys an existing immutable ECR tag without rebuilding. By default it",
        "picks the most-recent build pushed BEFORE the one currently deployed; `--to <tag>`",
        "redeploys a specific tag (rolling forward or back). It re-rolls the service in place",
        "(health-gated, zero-downtime) using the same path as `deploy --image`, so container",
        "config (cpu/memory/replicas/env/secrets) comes from the current launch-pad.toml.",
        "",
        "ECR keeps every immutable build, so any prior version is available to roll back to.",
        "",
        "Examples:",
        "  $ launchpad rollback --service web           # to the previous build",
        "  $ launchpad rollback --service web --to sha-abc123",
        "  $ launchpad rollback --service web --dry-run",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runRollback(mergedOpts<RollbackOptions>(command));
    });

  applyGlobalOptions(cmd);
}
