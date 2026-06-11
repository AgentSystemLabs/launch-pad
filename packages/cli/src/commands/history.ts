import { Command } from "commander";
import {
  type DeployEvent,
  deployEventsPrefix,
  envProject,
  LABEL_REGEX,
  parseDeployEvent,
} from "@agentsystemlabs/launch-pad-shared";
import { prepareAws } from "../aws/context";
import { getJson, listObjectKeys } from "../aws/s3-state";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

/** Cap how many event objects a single `history` call reads (newest-first). */
const MAX_SCAN = 500;
const DEFAULT_LIMIT = 10;

export interface HistoryOptions extends GlobalOpts {
  service?: string;
  env?: string;
  limit?: string;
}

/** The last `limit` events touching `service` (all when undefined), newest first. Pure. */
export function selectRecentEvents(
  events: readonly DeployEvent[],
  service: string | undefined,
  limit: number,
): DeployEvent[] {
  return [...events]
    .filter((e) => service === undefined || e.services.some((s) => s.service === service))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`invalid --limit "${raw}"`, { hint: "pass a whole number ≥ 1" });
  }
  return n;
}

/** The human-readable tail of a caller ARN (e.g. arn:…:user/cody → cody). */
function arnShort(arn: string): string {
  const slash = arn.lastIndexOf("/");
  return slash >= 0 ? arn.slice(slash + 1) : arn;
}

function tagOf(image: string): string {
  const colon = image.lastIndexOf(":");
  return colon >= 0 ? image.slice(colon + 1) : image;
}

function convergedBadge(converged: boolean | null): string {
  if (converged === null) return color.dim("published");
  return converged ? color.green("converged") : color.yellow("not converged");
}

export async function runHistory(opts: HistoryOptions): Promise<void> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run history from your project directory (or a parent)",
    });
  }
  const { config } = loadConfig();

  const env = opts.env;
  if (env !== undefined && !LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const ownerProject = envProject(config.project, env);
  const limit = parseLimit(opts.limit);
  if (opts.service !== undefined && !config.service.some((s) => s.name === opts.service)) {
    throw new CliError(`no service named "${opts.service}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }

  const aws = await prepareAws(opts);

  // Keys lead with the ISO timestamp → lexicographic desc is newest-first.
  const keys = (await listObjectKeys(aws.s3, aws.bucket, deployEventsPrefix(aws.clusterId, ownerProject)))
    .sort()
    .reverse()
    .slice(0, MAX_SCAN);

  const events: DeployEvent[] = [];
  for (const key of keys) {
    const obj = await getJson(aws.s3, aws.bucket, key);
    if (!obj) continue;
    try {
      events.push(parseDeployEvent(obj.raw));
    } catch {
      /* skip a malformed event — history is advisory */
    }
  }
  const recent = selectRecentEvents(events, opts.service, limit);

  if (isJsonMode()) {
    printJson({ project: ownerProject, events: recent });
    return;
  }

  if (recent.length === 0) {
    log.info(
      opts.service
        ? `no deploy history for ${color.cyan(opts.service)} in ${color.cyan(ownerProject)}`
        : `no deploy history for ${color.cyan(ownerProject)} yet`,
    );
    log.dim("  history is recorded from each `launch-pad deploy` onward");
    return;
  }

  log.plain();
  for (const e of recent) {
    const when = e.at.replace("T", " ").replace(/\..*$/, "");
    log.plain(
      `  ${color.cyan(when)}  ${color.dim(e.kind.padEnd(7))} ${convergedBadge(e.converged)}  ${color.dim(arnShort(e.by))}`,
    );
    for (const s of e.services) {
      log.plain(`    ${color.cyan(s.service)} → ${color.dim(tagOf(s.image))}  ${color.dim(`×${s.replicas}`)}`);
    }
  }
  log.plain();
}

export function registerHistory(program: Command): void {
  const cmd = program
    .command("history")
    .description("Show this project's deploy history (who / when / image / converged)")
    .option("--service <name>", "only deploys that touched this service")
    .option("--env <name>", "target a named environment footprint (same as deploy --env)")
    .option("--limit <n>", "how many deploys to show", String(DEFAULT_LIMIT))
    .addHelpText(
      "after",
      [
        "",
        "Each `deploy` appends an append-only event to S3 (per footprint). History is advisory —",
        "an audit trail and a hint for `rollback` — and is never read by the node agents.",
        "",
        "Examples:",
        "  $ launch-pad history",
        "  $ launch-pad history --service web --limit 20",
        "  $ launch-pad history --env staging",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runHistory(mergedOpts<HistoryOptions>(command));
    });

  applyGlobalOptions(cmd);
}
