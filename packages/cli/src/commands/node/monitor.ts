import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  envProject,
  hostMemoryPercent,
  LABEL_REGEX,
  type NodeRegistryEntry,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  parseStatsLine,
  type ServiceStats,
  STATS_EVENT,
  type StatsLine,
  systemLogGroupName,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import {
  filterAllLogEvents,
  isAccessDenied,
  isLogGroupMissing,
  type LogEvent,
} from "../../aws/cloudwatch-logs";
import { describeInstancesById, type Ec2Observation } from "../../aws/ec2";
import { runShellScriptOnInstances } from "../../aws/run-command";
import { getJson } from "../../aws/s3-state";
import { findConfigPath, loadConfig } from "../../config/load";
import { CliError } from "../../errors";
import { assertValidNodeId } from "../../validate-node-id";
import { ssmRunBashScript } from "../../provision/agent-upgrade";
import { renderStatsSampleScript } from "../../provision/stats-script";
import { type GlobalOpts, applyGlobalOptions, mergedOpts } from "../../globals";
import { isJsonMode, log, printJson } from "../../ui/log";
import { sparkline } from "../../ui/sparkline";
import { color } from "../../ui/theme";
import { parseSince } from "../logs";

interface MonitorOptions extends GlobalOpts {
  env?: string;
  since?: string;
  watch?: boolean;
  interval?: string;
  window?: string;
  service?: string;
}

const DEFAULT_SINCE = "1h";
const DEFAULT_WATCH_INTERVAL_S = 3;
const DEFAULT_WINDOW = "5m";
/** CloudWatch filter pattern: quoted so the `.` is matched literally. */
const STATS_FILTER_PATTERN = `"${STATS_EVENT}"`;

// ── pure data helpers (unit-tested) ────────────────────────────────────────────────

export interface StatsSample extends StatsLine {
  /** Epoch millis for ordering — the sample's own `ts`, falling back to the log time. */
  epochMillis: number;
}

/** Map CloudWatch log events → ordered stats samples, dropping non-stats lines. */
export function samplesFromLogEvents(events: LogEvent[]): StatsSample[] {
  const samples: StatsSample[] = [];
  for (const e of events) {
    const line = parseStatsLine(e.message);
    if (!line) continue;
    const parsedTs = Date.parse(line.ts);
    samples.push({ ...line, epochMillis: Number.isNaN(parsedTs) ? e.timestamp : parsedTs });
  }
  samples.sort((a, b) => a.epochMillis - b.epochMillis);
  return samples;
}

/** Service rows of one sample that match a `project/service` filter (all when no filter). */
export function matchingServices(
  sample: StatsLine,
  filter?: { project: string; service: string },
): ServiceStats[] {
  if (!filter) return sample.services;
  return sample.services.filter(
    (s) => s.service === filter.service && s.project === filter.project,
  );
}

export interface SeriesSummary {
  now: number;
  avg: number;
  max: number;
  min: number;
}

export function summarize(values: number[]): SeriesSummary {
  if (values.length === 0) return { now: 0, avg: 0, max: 0, min: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    now: values[values.length - 1] as number,
    avg: sum / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

/** Per-sample sum of a service's replicas (CPU% and used MB) for a filtered series. */
export function serviceSeries(
  samples: StatsSample[],
  filter: { project: string; service: string },
): { cpu: number[]; memUsed: number[]; replicas: number[] } {
  const cpu: number[] = [];
  const memUsed: number[] = [];
  const replicaSet = new Set<number>();
  for (const s of samples) {
    const rows = matchingServices(s, filter);
    cpu.push(rows.reduce((a, r) => a + r.cpuPercent, 0));
    memUsed.push(rows.reduce((a, r) => a + r.memoryUsedMb, 0));
    for (const r of rows) replicaSet.add(r.replica);
  }
  return { cpu, memUsed, replicas: [...replicaSet].sort((a, b) => a - b) };
}

// ── rendering ──────────────────────────────────────────────────────────────────────

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function row(label: string, spark: string, summaryText: string): string {
  return `  ${color.dim(label.padEnd(10))} ${color.cyan(spark)}  ${summaryText}`;
}

function renderView(
  nodeId: string,
  clusterId: string,
  samples: StatsSample[],
  filter: { project: string; service: string } | undefined,
  windowLabel: string,
): string[] {
  const lines: string[] = [];
  lines.push(
    `${color.cyan(`Monitor ${nodeId}`)}  ${color.dim(`(cluster ${clusterId} · ${windowLabel} · ${samples.length} sample${samples.length === 1 ? "" : "s"})`)}`,
  );
  lines.push("");

  if (samples.length === 0) {
    lines.push(color.dim("  no stats samples in this window — the agent emits one every ~60s"));
    lines.push(color.dim("  ensure logging is installed (`launch-pad node install-logging`) and the node is running"));
    return lines;
  }

  const cpu = summarize(samples.map((s) => s.host.cpuPercent));
  const memPct = summarize(samples.map((s) => hostMemoryPercent(s.host)));
  const latest = samples[samples.length - 1] as StatsSample;

  lines.push(
    row(
      "host cpu",
      sparkline(samples.map((s) => s.host.cpuPercent), { min: 0, max: 100 }),
      `now ${fmtPct(cpu.now)}  ${color.dim(`avg ${fmtPct(cpu.avg)}  max ${fmtPct(cpu.max)}`)}`,
    ),
  );
  lines.push(
    row(
      "host mem",
      sparkline(samples.map((s) => hostMemoryPercent(s.host)), { min: 0, max: 100 }),
      `now ${fmtPct(memPct.now)}  ${color.dim(`(${latest.host.memoryUsedMb}/${latest.host.memoryTotalMb} MB)`)}`,
    ),
  );
  lines.push("");

  if (filter) {
    const series = serviceSeries(samples, filter);
    const cpuS = summarize(series.cpu);
    const memS = summarize(series.memUsed);
    const label = `${filter.project}/${filter.service}`;
    lines.push(`  ${color.cyan(label)} ${color.dim(`(replicas: ${series.replicas.join(", ") || "none"})`)}`);
    lines.push(row("cpu Σ", sparkline(series.cpu), `now ${fmtPct(cpuS.now)}  ${color.dim(`max ${fmtPct(cpuS.max)}`)}`));
    lines.push(row("mem Σ", sparkline(series.memUsed), `now ${color.dim(`${Math.round(memS.now)} MB`)}`));
    return lines;
  }

  const rows = matchingServices(latest);
  if (rows.length === 0) {
    lines.push(color.dim("  no managed containers on this node"));
    return lines;
  }
  lines.push(color.dim("  services (latest sample)"));
  for (const r of rows) {
    lines.push(
      `    ${color.cyan(`${r.project}/${r.service}/${r.replica}`.padEnd(24))} ` +
        `cpu ${fmtPct(r.cpuPercent).padStart(6)}   ` +
        `mem ${color.dim(`${r.memoryUsedMb}/${r.memoryLimitMb} MB`)}`,
    );
  }
  return lines;
}

// ── shared setup ─────────────────────────────────────────────────────────────────────

async function loadNodeEntry(aws: AwsEnv, nodeId: string): Promise<NodeRegistryEntry> {
  const obj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, nodeId));
  if (!obj) {
    throw new CliError(`node "${nodeId}" does not exist in cluster "${aws.clusterId}"`, {
      hint: "list nodes with `launch-pad node list`",
    });
  }
  return parseNodeRegistryEntry(obj.raw);
}

/** Resolve `project/service` for `--service`, requiring a config to map the project. */
function resolveServiceFilter(
  opts: MonitorOptions,
): { project: string; service: string } | undefined {
  if (!opts.service) return undefined;
  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
  if (!findConfigPath(process.cwd())) {
    throw new CliError(`--service needs a launch-pad.toml to resolve the project for "${opts.service}"`, {
      hint: "run from your project directory, or drop --service to see every service on the node",
    });
  }
  const { config } = loadConfig();
  if (!config.service.some((s) => s.name === opts.service)) {
    throw new CliError(`no service named "${opts.service}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }
  return { project: envProject(config.project, opts.env), service: opts.service };
}

// ── historic mode ─────────────────────────────────────────────────────────────────────

async function fetchHistoric(aws: AwsEnv, nodeId: string, sinceMs: number): Promise<StatsSample[]> {
  const group = systemLogGroupName(aws.clusterId, nodeId);
  try {
    const events = await filterAllLogEvents(aws.logs, {
      logGroupName: group,
      startTime: Date.now() - sinceMs,
      filterPattern: STATS_FILTER_PATTERN,
    });
    return samplesFromLogEvents(events);
  } catch (error) {
    if (isLogGroupMissing(error)) return [];
    if (isAccessDenied(error)) {
      throw new CliError(`access denied reading system log group ${group}`, {
        hint: "your AWS profile needs logs:FilterLogEvents on /launch-pad/* — see docs/overview.md",
      });
    }
    throw error;
  }
}

async function runHistoric(
  aws: AwsEnv,
  nodeId: string,
  opts: MonitorOptions,
  filter: { project: string; service: string } | undefined,
): Promise<void> {
  const window = opts.since ?? DEFAULT_SINCE;
  const samples = await fetchHistoric(aws, nodeId, parseSince(window));

  if (isJsonMode()) {
    printJson({ node: nodeId, cluster: aws.clusterId, window, samples });
    return;
  }
  log.plain();
  for (const line of renderView(nodeId, aws.clusterId, samples, filter, `last ${window}`)) {
    log.plain(line);
  }
  log.plain();
}

// ── watch mode (live, SSM) ─────────────────────────────────────────────────────────────

function requireSsmTarget(entry: NodeRegistryEntry, obs: Ec2Observation): string {
  if (!entry.instanceId || obs.kind !== "running") {
    throw new CliError(`node "${entry.nodeId}" has no running instance to sample`, {
      hint: "start it with `launch-pad node resume`, or use historic mode (--since) instead",
    });
  }
  return entry.instanceId;
}

async function sampleOverSsm(aws: AwsEnv, instanceId: string, script: string[]): Promise<StatsSample | null> {
  const [result] = await runShellScriptOnInstances(aws.ssm, [instanceId], script, 30_000);
  if (!result || result.status !== "Success") {
    throw new CliError(
      `live sample failed on ${instanceId}: ${(result?.stderr || result?.status || "no result").trim().slice(0, 200)}`,
    );
  }
  for (const line of result.stdout.split("\n")) {
    const parsed = parseStatsLine(line);
    if (parsed) {
      const ts = Date.parse(parsed.ts);
      return { ...parsed, epochMillis: Number.isNaN(ts) ? Date.now() : ts };
    }
  }
  return null;
}

function clearScreen(): void {
  process.stderr.write("\x1b[2J\x1b[3J\x1b[H");
}

async function runWatch(
  aws: AwsEnv,
  entry: NodeRegistryEntry,
  opts: MonitorOptions,
  filter: { project: string; service: string } | undefined,
): Promise<void> {
  const obs = (await describeInstancesById(aws.ec2, entry.instanceId ? [entry.instanceId] : [])).get(
    entry.instanceId ?? "",
  ) ?? { kind: "missing" as const };
  const instanceId = requireSsmTarget(entry, obs);

  const intervalS = opts.interval ? Number.parseInt(opts.interval, 10) : DEFAULT_WATCH_INTERVAL_S;
  if (!Number.isInteger(intervalS) || intervalS < 1) {
    throw new CliError(`invalid --interval "${opts.interval}"`, { hint: "pass whole seconds ≥ 1" });
  }
  const windowMs = parseSince(opts.window ?? DEFAULT_WINDOW);
  const capacity = Math.max(2, Math.ceil(windowMs / (intervalS * 1000)));
  const script = ssmRunBashScript(renderStatsSampleScript(entry.nodeId));

  const ring: StatsSample[] = [];
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Optional seed from CloudWatch history so the graph isn't empty on the first frame.
  if (opts.since) {
    try {
      ring.push(...(await fetchHistoric(aws, entry.nodeId, parseSince(opts.since))).slice(-capacity));
    } catch {
      /* seeding is best-effort */
    }
  }

  log.dim("  sampling over SSM — press Ctrl+C to stop");
  while (running) {
    let errorLine: string | null = null;
    try {
      const sample = await sampleOverSsm(aws, instanceId, script);
      if (sample) {
        ring.push(sample);
        while (ring.length > capacity) ring.shift();
        if (isJsonMode()) process.stdout.write(`${JSON.stringify(sample)}\n`);
      }
    } catch (error) {
      errorLine = error instanceof Error ? error.message : String(error);
    }

    if (!isJsonMode()) {
      clearScreen();
      const lines = renderView(
        entry.nodeId,
        aws.clusterId,
        ring,
        filter,
        `live · ${intervalS}s · window ${opts.window ?? DEFAULT_WINDOW}`,
      );
      process.stderr.write(`\n${lines.join("\n")}\n`);
      if (errorLine) process.stderr.write(`\n${color.yellow(`  last sample failed: ${errorLine}`)}\n`);
    }

    if (!running) break;
    await sleep(intervalS * 1000);
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

// ── entry point ────────────────────────────────────────────────────────────────────────

async function runMonitor(nodeId: string, opts: MonitorOptions): Promise<void> {
  assertValidNodeId(nodeId);
  const filter = resolveServiceFilter(opts);
  const aws = await prepareAws(opts);
  const entry = await loadNodeEntry(aws, nodeId);

  if (opts.watch) {
    await runWatch(aws, entry, opts, filter);
    return;
  }
  await runHistoric(aws, entry.nodeId, opts, filter);
}

export function registerMonitor(node: Command): void {
  const monitor = node
    .command("monitor <nodeId>")
    .description("Show a node's CPU/memory usage over time (historic from logs, or live with --watch)")
    .option("--since <window>", "historic window to read (15m, 1h, 24h, 7d)", DEFAULT_SINCE)
    .option("--watch", "live mode: poll the node over SSM and redraw until Ctrl+C")
    .option("--interval <sec>", "watch poll interval in seconds", String(DEFAULT_WATCH_INTERVAL_S))
    .option("--window <duration>", "watch graph ring-buffer span (15m, 5m, …)", DEFAULT_WINDOW)
    .option("--service <name>", "only graph this service (needs launch-pad.toml to resolve the project)")
    .option("--env <name>", "resolve --service against the named environment (<project>-<env>)")
    .addHelpText(
      "after",
      [
        "",
        "Historic mode reads the node's system log group for `launchpad.stats` lines the",
        "agent emits every ~60s (needs logs:FilterLogEvents). Live mode samples the node",
        "directly over SSM every few seconds — the instance must be running and SSM-managed.",
        "",
        "Examples:",
        "  $ launch-pad node monitor node-prod-1 --since 1h",
        "  $ launch-pad node monitor node-prod-1 --watch",
        "  $ launch-pad node monitor node-prod-1 --watch --service api",
        "  $ launch-pad node monitor node-prod-1 --since 1h --watch   # seed history, then live",
      ].join("\n"),
    )
    .action(async (nodeId: string, _opts, command: Command) => {
      await runMonitor(nodeId, mergedOpts<MonitorOptions>(command));
    });
  applyGlobalOptions(monitor);
}
