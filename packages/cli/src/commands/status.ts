import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import {
  footprintOwner,
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  LABEL_REGEX,
  type NodeRegistryEntry,
  type NodeStatus,
  nodeRegistryKey,
  parseNodeRegistryEntry,
  parseNodeStatus,
  type ServiceState,
  statusKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../aws/context";
import { getJson, listNodeIds } from "../aws/s3-state";
import { loadDeployedPlacement } from "../deploy/deployed-footprint";
import { findConfigPath, loadConfig } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface StatusOptions extends GlobalOpts {
  node?: string;
  env?: string;
  watch?: boolean;
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
  registry: NodeRegistryEntry | null;
}

async function fetchNodes(aws: AwsEnv, nodeIds: string[]): Promise<NodeView[]> {
  const views: NodeView[] = [];
  for (const id of nodeIds) {
    const obj = await getJson(aws.s3, aws.bucket, statusKey(aws.clusterId, id));
    let status: NodeStatus | null = null;
    if (obj) {
      try {
        status = parseNodeStatus(obj.raw);
      } catch {
        status = null;
      }
    }
    const regObj = await getJson(aws.s3, aws.bucket, nodeRegistryKey(aws.clusterId, id));
    let registry: NodeRegistryEntry | null = null;
    if (regObj) {
      try {
        registry = parseNodeRegistryEntry(regObj.raw);
      } catch {
        registry = null;
      }
    }
    views.push({ id, status, registry });
  }
  return views;
}

function render(views: NodeView[], filterProject?: string): void {
  const now = Date.now();
  for (const view of views) {
    if (!view.status) {
      const missingExternal =
        view.registry?.provisioning === "external" &&
        (view.registry.state === "ready" || view.registry.state === "provisioning");
      log.plain(
        `  ${color.cyan(view.id)}  ${
          missingExternal ? color.yellow("stale (no heartbeat)") : color.dim("no agent status yet")
        }`,
      );
      continue;
    }
    const stale = isHeartbeatStale(view.status.lastSeen, now, HEARTBEAT_STALE_MS);
    const age = formatAge(view.status.lastSeen, now);
    const beat = stale ? color.yellow(`stale (${age})`) : color.green(`live · ${age}`);
    log.plain(`  ${color.cyan(view.id)}  ${color.dim(view.status.agentId)}  ${beat}`);

    const services = filterProject
      ? view.status.services.filter((s) => s.project === filterProject)
      : view.status.services;
    if (services.length === 0) {
      log.dim(filterProject ? `    no services for ${filterProject}` : "    no services running");
    }
    for (const s of services) {
      const paint = stateColor(s.state);
      const tag = s.image.split(":").pop() ?? s.image;
      const message = s.message && s.state !== "running" ? color.dim(` — ${s.message}`) : "";
      log.plain(
        `    ${paint("●")} ${color.cyan(`${s.project}/${s.service}`)}  ${paint(s.state)}  ${color.dim(tag)}${message}`,
      );
    }
  }
}

async function resolveNodeIds(opts: StatusOptions, aws: AwsEnv): Promise<string[]> {
  if (opts.node) return [opts.node];
  const { config } = loadConfig();
  const ids = new Set<string>();
  // Scope to the nodes this footprint actually occupies (per published
  // desired.json); fall back to every cluster node only when nothing is
  // published yet (e.g. status before the first deploy).
  const owner = footprintOwner(config, opts.env);
  const placement = await loadDeployedPlacement(aws.s3, aws.bucket, aws.clusterId, owner);
  if (placement.occupiedNodeIds.length > 0) {
    for (const id of placement.occupiedNodeIds) ids.add(id);
  } else {
    for (const id of await listNodeIds(aws.s3, aws.bucket, aws.clusterId)) ids.add(id);
  }
  return [...ids];
}

async function runStatus(opts: StatusOptions): Promise<void> {
  if (!opts.node && !findConfigPath(process.cwd())) {
    throw new CliError("no --node given and no launch-pad.toml found", {
      hint: "pass --node <id>, or run from a project directory",
    });
  }

  // --env scopes the view to that environment's footprint (`<project>-<env>`).
  let filterProject: string | undefined;
  if (opts.env !== undefined) {
    if (!LABEL_REGEX.test(opts.env)) {
      throw new CliError(`invalid --env "${opts.env}"`, {
        hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
      });
    }
    if (!findConfigPath(process.cwd())) {
      throw new CliError("--env needs a launch-pad.toml to resolve the project", {
        hint: "run from a project directory, or drop --env",
      });
    }
    filterProject = footprintOwner(loadConfig().config, opts.env);
  }

  const aws = await prepareAws(opts);
  const nodeIds = await resolveNodeIds(opts, aws);

  if (isJsonMode()) {
    const views = await fetchNodes(aws, nodeIds);
    const out = filterProject
      ? views.map((v) => ({
          node: v.id,
          status: v.status
            ? { ...v.status, services: v.status.services.filter((s) => s.project === filterProject) }
            : v.status,
        }))
      : views.map((v) => ({ node: v.id, status: v.status }));
    printJson(out);
    return;
  }

  if (opts.watch) {
    for (;;) {
      log.plain(color.dim(`— ${new Date().toLocaleTimeString()} —`));
      render(await fetchNodes(aws, nodeIds), filterProject);
      log.plain();
      await sleep(3000);
    }
  }

  log.plain();
  render(await fetchNodes(aws, nodeIds), filterProject);
  log.plain();
}

export function registerStatus(program: Command): void {
  const cmd = program
    .command("status")
    .description("Show the status of your services on their nodes")
    .option("--node <nodeId>", "only show this node (default: nodes referenced by launch-pad.toml)")
    .option("--env <name>", "only show this environment's footprint (<project>-<env>)")
    .option("--watch", "re-poll continuously until interrupted")
    .action(async (_opts, command: Command) => {
      await runStatus(mergedOpts<StatusOptions>(command));
    });

  applyGlobalOptions(cmd);
}
