import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  type NodeStatus,
  parseNodeStatus,
  type ServiceState,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { getJson } from "../aws/s3-state";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface StatusOptions extends GlobalOpts {
  node?: string;
  watch?: boolean;
}

function resolveNodeIds(opts: StatusOptions): string[] {
  if (opts.node) return [opts.node];
  if (!findConfigPath(process.cwd())) {
    throw new CliError("no --node given and no launch-pad.toml found", {
      hint: "pass --node <id>, or run from a project directory",
    });
  }
  return [...new Set(loadConfig().config.service.map((s) => s.node))];
}

function formatAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function stateColor(state: ServiceState): (s: string) => string {
  switch (state) {
    case "running":
      return color.green;
    case "error":
      return color.red;
    case "stopped":
      return color.yellow;
    default:
      return color.cyan;
  }
}

interface NodeView {
  id: string;
  status: NodeStatus | null;
}

async function fetchNodes(aws: AwsEnv, nodeIds: string[]): Promise<NodeView[]> {
  const views: NodeView[] = [];
  for (const id of nodeIds) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(id));
    let status: NodeStatus | null = null;
    if (obj) {
      try {
        status = parseNodeStatus(obj.raw);
      } catch {
        status = null;
      }
    }
    views.push({ id, status });
  }
  return views;
}

function render(views: NodeView[]): void {
  const now = Date.now();
  for (const view of views) {
    if (!view.status) {
      log.plain(`  ${color.cyan(view.id)}  ${color.dim("no agent status yet")}`);
      continue;
    }
    const stale = isHeartbeatStale(view.status.lastSeen, now, HEARTBEAT_STALE_MS);
    const age = formatAge(view.status.lastSeen, now);
    const beat = stale ? color.yellow(`stale (${age})`) : color.green(`live · ${age}`);
    log.plain(`  ${color.cyan(view.id)}  ${color.dim(view.status.agentId)}  ${beat}`);

    if (view.status.services.length === 0) {
      log.dim("    no services running");
    }
    for (const s of view.status.services) {
      const paint = stateColor(s.state);
      const tag = s.image.split(":").pop() ?? s.image;
      const message = s.message && s.state !== "running" ? color.dim(` — ${s.message}`) : "";
      log.plain(
        `    ${paint("●")} ${color.cyan(`${s.project}/${s.service}`)}  ${paint(s.state)}  ${color.dim(tag)}${message}`,
      );
    }
  }
}

async function runStatus(opts: StatusOptions): Promise<void> {
  const nodeIds = resolveNodeIds(opts);
  const aws = await prepareAws(opts);

  if (isJsonMode()) {
    const views = await fetchNodes(aws, nodeIds);
    printJson(views.map((v) => ({ node: v.id, status: v.status })));
    return;
  }

  if (opts.watch) {
    for (;;) {
      log.plain(color.dim(`— ${new Date().toLocaleTimeString()} —`));
      render(await fetchNodes(aws, nodeIds));
      log.plain();
      await sleep(3000);
    }
  }

  log.plain();
  render(await fetchNodes(aws, nodeIds));
  log.plain();
}

export function registerStatus(program: Command): void {
  const cmd = program
    .command("status")
    .description("Show the status of your services on their nodes")
    .option("--node <nodeId>", "only show this node (default: nodes referenced by launch-pad.toml)")
    .option("--watch", "re-poll continuously until interrupted")
    .action(async (opts: StatusOptions) => {
      await runStatus(opts);
    });

  applyGlobalOptions(cmd);
}
