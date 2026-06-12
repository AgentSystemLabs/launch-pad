import { Command } from "commander";
import {
  DEFAULT_COMPONENT,
  isPreviewExpired,
  LABEL_REGEX,
  type ProjectIndex,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import { loadNodeDesiredStates } from "../../deploy/deployed-footprint";
import { CliError } from "../../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../../globals";
import { loadEnvMarkers } from "../../preview/markers";
import { loadProjectIndex, loadProjectIndexes } from "../../project/registry";
import {
  buildFootprintList,
  buildProjectComponentViews,
  componentDisplayName,
  describeEnvMarker,
  resolveFootprintOwner,
  summarizeFootprintServices,
  type FootprintListEntry,
  type FootprintServiceSummary,
} from "../../project/footprint-view";
import { panel, table } from "../../ui/box";
import { isJsonMode, log, printJson } from "../../ui/log";
import { color } from "../../ui/theme";

interface ProjectOptions extends GlobalOpts {
  env?: string;
}

function assertProjectName(name: string): void {
  if (!LABEL_REGEX.test(name)) {
    throw new CliError(`invalid project name "${name}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
}

function assertEnvName(env: string): void {
  if (!LABEL_REGEX.test(env)) {
    throw new CliError(`invalid --env "${env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }
}

function formatFootprintServiceLine(s: FootprintServiceSummary): string {
  const tag = s.image.split(":").pop() ?? s.image;
  const replicas = s.replicas > 1 ? `  ${color.dim(`×${s.replicas}`)}` : "";
  const domain = s.domain ? `  ${color.dim(s.domain)}` : "";
  const cron = s.cron ? `  ${color.dim(`cron ${s.cron}`)}` : "";
  const nodes = s.nodeIds.map((id) => color.cyan(id)).join(", ");
  return `    ${color.cyan(s.service)}${replicas}  ${color.dim(tag)}${domain}${cron}  ${color.dim("→")} ${nodes}`;
}

function footprintLabel(entry: FootprintListEntry): string {
  return entry.env === null ? color.dim("base") : `env ${color.cyan(entry.env)}`;
}

function formatFootprintListLine(entry: FootprintListEntry, nowMs: number): string {
  const component =
    entry.component !== null && componentDisplayName(entry.component) !== null
      ? ` · ${color.cyan(entry.component)}`
      : "";
  const name =
    entry.env === null
      ? `${color.cyan(entry.baseProject)}${component}`
      : `${color.cyan(entry.baseProject)}${component} · ${footprintLabel(entry)}`;
  const services =
    entry.services.length === 0
      ? color.dim("nothing scheduled")
      : `${entry.services.length} service${entry.services.length === 1 ? "" : "s"}`;
  const nodes =
    entry.nodeIds.length > 0 ? color.dim(` · ${entry.nodeIds.join(", ")}`) : "";
  const expiry =
    entry.marker !== null
      ? `  ${color.dim(describeEnvMarker(entry.marker, nowMs).split(" · ").slice(2).join(" · "))}`
      : "";
  const line = `${name}  ${services}${nodes}${expiry}`;
  return entry.expired ? color.yellow(line) : line;
}

async function loadClusterFootprints(aws: AwsEnv): Promise<{
  nodeStates: Awaited<ReturnType<typeof loadNodeDesiredStates>>;
  markers: Awaited<ReturnType<typeof loadEnvMarkers>>;
}> {
  const [nodeStates, markers] = await Promise.all([
    loadNodeDesiredStates(aws.s3, aws.bucket, aws.clusterId),
    loadEnvMarkers(aws),
  ]);
  return { nodeStates, markers };
}

async function runList(opts: ProjectOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const [{ nodeStates, markers }, indexes] = await Promise.all([
    loadClusterFootprints(aws),
    loadProjectIndexes(aws),
  ]);
  const nowMs = Date.now();
  const footprints = buildFootprintList(markers, nodeStates, nowMs, indexes);

  if (isJsonMode()) {
    printJson({
      footprints: footprints.map(({ marker, expired, services, ...rest }) => ({
        ...rest,
        expired,
        serviceCount: services.length,
        services,
        ...(marker ? { marker } : {}),
      })),
    });
    return;
  }

  if (footprints.length === 0) {
    log.info("no projects deployed in this cluster");
    log.dim("  deploy one with `launchpad deploy` from a project directory");
    return;
  }

  panel(
    "Projects",
    footprints.map((entry) => formatFootprintListLine(entry, nowMs)),
  );
  log.dim("  inspect one: launchpad project show <name> · env: add --env <name>");
}

/** The federation view: one logical project, component-grouped services. */
async function showFederatedProject(
  aws: AwsEnv,
  name: string,
  index: ProjectIndex,
  opts: ProjectOptions,
): Promise<void> {
  const { nodeStates, markers } = await loadClusterFootprints(aws);
  const nowMs = Date.now();
  const views = buildProjectComponentViews(index, nodeStates, opts.env);
  const allNodeIds = [...new Set(views.flatMap((v) => v.nodeIds))].sort();
  const deployedViews = views.filter((v) => v.services.length > 0);

  if (opts.env !== undefined && deployedViews.length === 0) {
    throw new CliError(`project "${name}" has no "${opts.env}" environment deployed`, {
      hint: "create one with `launchpad deploy --env <name>` from a component directory",
    });
  }

  if (isJsonMode()) {
    printJson({
      project: name,
      env: opts.env ?? null,
      cluster: aws.clusterId,
      components: views.map((v) => ({
        component: v.component,
        owner: v.owner,
        nodeIds: v.nodeIds,
        services: v.services,
        ...(opts.env !== undefined
          ? { marker: markers.find((m) => m.owner === v.owner) ?? null }
          : {}),
      })),
    });
    return;
  }

  const title = opts.env !== undefined ? `Project ${name} · env ${opts.env}` : `Project ${name}`;
  const serviceCount = views.reduce((n, v) => n + v.services.length, 0);
  panel(title, [
    ...table([
      ["components", String(index.components.length)],
      ["services", String(serviceCount)],
      ["cluster", aws.clusterId],
      ["nodes", allNodeIds.length > 0 ? allNodeIds.join(", ") : color.dim("none")],
    ]),
  ]);

  for (const v of views) {
    const marker = markers.find((m) => m.owner === v.owner) ?? null;
    const lines: string[] = [];
    if (v.services.length === 0) {
      lines.push(color.dim(opts.env !== undefined ? "    no env footprint deployed" : "    nothing scheduled"));
    } else {
      for (const s of v.services) lines.push(formatFootprintServiceLine(s));
    }
    if (marker && isPreviewExpired(marker, nowMs)) {
      lines.push(color.yellow(`    EXPIRED ${marker.expiresAt}`));
    }
    panel(`Component ${v.component} ${color.dim(`(${v.owner})`)}`, lines);
  }
  log.dim("  destroy everything: launchpad destroy --project <name> · one component: launchpad destroy from its directory");
}

async function runShow(name: string, opts: ProjectOptions): Promise<void> {
  assertProjectName(name);
  if (opts.env !== undefined) assertEnvName(opts.env);

  const aws = await prepareAws(opts);

  // A component registry makes `name` a LOGICAL project: aggregate every
  // component's footprint. A lone "default" entry is just a single-TOML project
  // — the classic single-footprint view below renders it identically.
  const index = await loadProjectIndex(aws, name);
  if (index !== null && (index.components.length > 1 || index.components[0]?.component !== DEFAULT_COMPONENT)) {
    await showFederatedProject(aws, name, index, opts);
    return;
  }

  const owner = resolveFootprintOwner(name, opts.env);
  const { nodeStates, markers } = await loadClusterFootprints(aws);
  const nowMs = Date.now();
  const services = summarizeFootprintServices(nodeStates, owner);
  const marker = markers.find((m) => m.owner === owner) ?? null;
  const nodeIds = [...new Set(services.flatMap((s) => s.nodeIds))].sort();

  if (services.length === 0 && marker === null) {
    const scope = opts.env !== undefined ? ` (env ${opts.env})` : "";
    throw new CliError(`project "${name}"${scope} is not deployed in this cluster`, {
      hint:
        opts.env !== undefined
          ? "create it with `launchpad deploy --env <name>` from the project directory"
          : "deploy it with `launchpad deploy` from the project directory, or list what's deployed: launchpad project list",
    });
  }

  if (isJsonMode()) {
    printJson({
      project: name,
      env: opts.env ?? null,
      owner,
      cluster: aws.clusterId,
      expired: marker ? isPreviewExpired(marker, nowMs) : false,
      marker,
      nodeIds,
      services,
    });
    return;
  }

  const title =
    opts.env !== undefined
      ? `Project ${name} · env ${opts.env}`
      : `Project ${name}`;
  const rows: Array<[string, string]> = [
    ["footprint", owner],
    ["cluster", aws.clusterId],
    ["nodes", nodeIds.length > 0 ? nodeIds.join(", ") : color.dim("none")],
    ["services", String(services.length)],
  ];
  if (marker) {
    rows.push(["expires", describeEnvMarker(marker, nowMs).split(" · ").slice(2).join(" · ")]);
    if (marker.domains.length > 0) rows.push(["domains", marker.domains.join(", ")]);
  }

  panel(title, [...table(rows)]);

  const serviceLines: string[] = [];
  if (services.length === 0) {
    serviceLines.push(color.dim("    nothing scheduled"));
  } else {
    for (const s of services) serviceLines.push(formatFootprintServiceLine(s));
  }
  panel("Services", serviceLines);

  if (marker && isPreviewExpired(marker, nowMs)) {
    log.warn("this environment is past its TTL — destroy it or redeploy to extend");
  }
  log.dim("  live health: launchpad status from the project directory · destroy env: launchpad destroy --env <name>");
}

export function registerProject(program: Command): void {
  const project = program
    .command("project")
    .description("Inspect deployed project footprints in the active cluster");

  const list = project
    .command("list")
    .description("List every deployed project footprint (base and named environments)")
    .action(async (_opts, command: Command) => {
      await runList(mergedOpts<ProjectOptions>(command));
    });
  applyGlobalOptions(list);

  const show = project
    .command("show <name>")
    .description("Show a project's scheduled services, domains, and node placement")
    .option("--env <name>", "named environment footprint (same as deploy --env)")
    .action(async (name: string, _opts, command: Command) => {
      await runShow(name, mergedOpts<ProjectOptions>(command));
    });
  applyGlobalOptions(show);
}
