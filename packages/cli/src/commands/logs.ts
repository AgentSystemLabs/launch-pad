import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  envProject,
  LABEL_REGEX,
  logGroupName,
  parseLogStreamName,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import {
  filterAllLogEvents,
  isAccessDenied,
  isLogGroupMissing,
  type LogEvent,
} from "../aws/cloudwatch-logs";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface LogsOptions extends GlobalOpts {
  env?: string;
  since?: string;
  tail?: string;
  follow?: boolean;
  filter?: string;
}

const DEFAULT_SINCE = "15m";
const FOLLOW_INTERVAL_MS = 2000;
/**
 * Cap on the dedup set during `--follow`. Each polled event id is remembered so a
 * line isn't printed twice across overlapping poll windows; past this many ids we
 * drop the whole set (the oldest ids are already outside the poll window, so they
 * can't reappear). Just a memory bound on a long-lived stream, not a correctness knob.
 */
const FOLLOW_DEDUP_CACHE_MAX = 50_000;

/** Parse a relative window like `15m`, `1h`, `24h`, `7d` (also `s`) into milliseconds. */
export function parseSince(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new CliError(`invalid --since "${input}"`, {
      hint: "use a relative window like 15m, 1h, 24h, or 7d",
    });
  }
  const n = Number.parseInt(match[1] as string, 10);
  const unit = match[2];
  const ms = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * ms;
}

/**
 * Unwrap a docker json-file log line — `{"log":"text\n","stream":"stdout",…}` → `text`.
 * Falls back to the raw line (minus a trailing newline) when it isn't json-wrapped.
 */
export function unwrapDockerLogLine(message: string): string {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { log?: unknown };
      if (typeof parsed.log === "string") return parsed.log.replace(/\n$/, "");
    } catch {
      /* not docker json — fall through */
    }
  }
  return message.replace(/\n$/, "");
}

/** Render `{nodeId}/{replica}` from a stream name, or the raw stream for a system stream. */
function streamLabel(streamName: string): string {
  const parsed = parseLogStreamName(streamName);
  return parsed ? `${parsed.nodeId}/${parsed.replicaIndex}` : streamName;
}

function printEvent(event: LogEvent): void {
  const ts = new Date(event.timestamp).toISOString();
  const where = streamLabel(event.logStreamName);
  log.plain(`${color.dim(ts)} ${color.cyan(`[${where}]`)} ${unwrapDockerLogLine(event.message)}`);
}

function toJsonEvent(event: LogEvent): Record<string, unknown> {
  const parsed = parseLogStreamName(event.logStreamName);
  return {
    timestamp: new Date(event.timestamp).toISOString(),
    epochMillis: event.timestamp,
    node: parsed?.nodeId ?? null,
    replica: parsed?.replicaIndex ?? null,
    stream: event.logStreamName,
    message: unwrapDockerLogLine(event.message),
  };
}

async function streamFollow(
  aws: AwsEnv,
  group: string,
  startTime: number,
  filterPattern: string | undefined,
): Promise<void> {
  const seen = new Set<string>();
  let from = startTime;
  for (;;) {
    try {
      const events = await filterAllLogEvents(aws.logs, {
        logGroupName: group,
        startTime: from,
        filterPattern,
      });
      events.sort((a, b) => a.timestamp - b.timestamp);
      for (const e of events) {
        if (e.eventId && seen.has(e.eventId)) continue;
        if (e.eventId) seen.add(e.eventId);
        // Follow mode streams forever, so JSON output must be newline-delimited
        // (one compact object per line) — not the pretty multi-line blocks
        // `printJson` emits — so a line-based consumer can parse each event as it
        // arrives. (Matches `node monitor --watch --json`.)
        if (isJsonMode()) process.stdout.write(`${JSON.stringify(toJsonEvent(e))}\n`);
        else printEvent(e);
        if (e.timestamp > from) from = e.timestamp;
      }
      // Bound memory on a long-lived follow — old ids fall outside the poll window.
      if (seen.size > FOLLOW_DEDUP_CACHE_MAX) seen.clear();
    } catch (error) {
      if (!isLogGroupMissing(error)) throw error;
      // Group not created yet — keep waiting for the first events.
    }
    await sleep(FOLLOW_INTERVAL_MS);
  }
}

async function runLogs(service: string, opts: LogsOptions): Promise<void> {
  if (!findConfigPath(process.cwd())) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run from your project directory (or a parent), or pass --cluster/--region explicitly",
    });
  }
  const { config } = loadConfig();

  const decl = config.service.find((s) => s.name === service);
  if (!decl) {
    throw new CliError(`no service named "${service}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }

  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  const project = envProject(config.project, opts.env);

  const aws = await prepareAws(opts);
  const group = logGroupName(aws.clusterId, project, service);

  const startTime = Date.now() - parseSince(opts.since ?? DEFAULT_SINCE);

  if (opts.follow) {
    await streamFollow(aws, group, startTime, opts.filter);
    return;
  }

  let events: LogEvent[];
  try {
    events = await filterAllLogEvents(aws.logs, {
      logGroupName: group,
      startTime,
      filterPattern: opts.filter,
    });
  } catch (error) {
    if (isLogGroupMissing(error)) {
      if (isJsonMode()) printJson({ logGroup: group, events: [] });
      else {
        log.info(`no logs yet for ${color.cyan(`${project}/${service}`)}`);
        log.dim(
          `  the service may not have run since logging was enabled — group ${group} doesn't exist`,
        );
      }
      return;
    }
    if (isAccessDenied(error)) {
      throw new CliError(`access denied reading log group ${group}`, {
        hint: "your AWS profile needs read access (logs:FilterLogEvents) to /launch-pad/* log groups — see docs/overview.md",
      });
    }
    throw error;
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  if (opts.tail !== undefined) {
    const n = Number.parseInt(opts.tail, 10);
    if (Number.isNaN(n) || n < 0) {
      throw new CliError(`invalid --tail "${opts.tail}"`, { hint: "pass a non-negative integer, e.g. --tail 200" });
    }
    events = events.slice(-n);
  }

  if (isJsonMode()) {
    printJson({ logGroup: group, events: events.map(toJsonEvent) });
    return;
  }

  for (const e of events) printEvent(e);
  if (events.length === 0) {
    log.dim(`  no log events in the last ${opts.since ?? DEFAULT_SINCE} — try a longer --since`);
  }
}

export function registerLogs(program: Command): void {
  const cmd = program
    .command("logs <service>")
    .description("Stream a service's logs from CloudWatch, merged across all nodes/replicas")
    .option("--env <name>", "read the named environment's footprint (<project>-<env>)")
    .option("--since <window>", "how far back to read (15m, 1h, 24h, 7d)", DEFAULT_SINCE)
    .option("--tail <n>", "only show the last N lines of the window")
    .option("--follow", "keep streaming new lines (like tail -f); Ctrl+C to stop")
    .option("--filter <pattern>", "CloudWatch filter pattern (a bare term matches that term)")
    .addHelpText(
      "after",
      [
        "",
        "Reads /launch-pad/<cluster>/<project>/<service>, merging every replica on every node.",
        "Your local AWS profile needs read access (logs:FilterLogEvents) to those groups.",
        "",
        "Examples:",
        "  $ launch-pad logs api",
        "  $ launch-pad logs api --env staging --since 1h --tail 200",
        "  $ launch-pad logs api --follow",
        '  $ launch-pad logs api --filter "error"',
      ].join("\n"),
    )
    .action(async (service: string, _opts, command: Command) => {
      await runLogs(service, mergedOpts<LogsOptions>(command));
    });

  applyGlobalOptions(cmd);
}
