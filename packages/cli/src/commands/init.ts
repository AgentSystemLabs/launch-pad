import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, InvalidArgumentError } from "commander";
import { parse as parseToml } from "smol-toml";
import { ZodError } from "zod";
import { LABEL_REGEX, parseLaunchPadConfig } from "@agentsystemlabs/launch-pad-shared";
import { CONFIG_FILENAME, formatZodError } from "../config/load";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts } from "../globals";
import { panel } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";

interface InitOptions extends GlobalOpts {
  name?: string;
  node?: string;
  domain?: string;
  port?: number;
  dockerfile?: string;
  cpu?: number;
  memory?: number;
  force?: boolean;
}

interface ServiceValues {
  name: string;
  node: string;
  dockerfile: string;
  cpu: number;
  memory: number;
  domain?: string;
  port?: number;
}

const DEFAULT_NODE = "node-dev-1";
const DEFAULT_CPU = 512;
const DEFAULT_MEMORY = 512;
const DEFAULT_PORT = 3000;

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

/** Coerce arbitrary text into a valid launch-pad label. */
export function toLabel(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "app";
}

/** TOML basic-string quoting (JSON strings are valid TOML basic strings here). */
function q(value: string): string {
  return JSON.stringify(value);
}

function renderToml(project: string, svc: ServiceValues): string {
  const lines: string[] = [
    "# launch-pad project config.",
    `# Deploy with: npx @agentsystemlabs/launch-pad deploy`,
    `project = ${q(project)}`,
    "",
    "[[service]]",
    `name = ${q(svc.name)}`,
    `node = ${q(svc.node)}`,
    `dockerfile = ${q(svc.dockerfile)}`,
    `cpu = ${svc.cpu}      # vCPU shares (1024 = 1 vCPU)`,
    `memory = ${svc.memory}   # MB`,
  ];

  if (svc.domain !== undefined && svc.port !== undefined) {
    lines.push(`domain = ${q(svc.domain)}`, `port = ${svc.port}`);
  } else {
    lines.push(
      "# This service is a background worker (no domain/port).",
      "# To serve web traffic, add a domain and the port your app listens on:",
      '# domain = "app.example.com"',
      "# port = 3000",
    );
  }

  lines.push('env = { NODE_ENV = "production" }', "");
  return `${lines.join("\n")}\n`;
}

async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} ${color.dim(`(${fallback})`)}: `)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}

async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  const def = fallback ? "Y/n" : "y/N";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} ${color.dim(`(${def})`)}: `)).trim().toLowerCase();
    if (answer === "") return fallback;
    return answer.startsWith("y");
  } finally {
    rl.close();
  }
}

async function gatherValues(opts: InitOptions, cwd: string): Promise<{ project: string; svc: ServiceValues }> {
  const interactive = process.stdin.isTTY === true && !isJsonMode();

  let name = opts.name;
  if (name === undefined) {
    const fallback = toLabel(basename(cwd));
    name = interactive ? await ask("Project / service name", fallback) : fallback;
  }
  name = toLabel(name);

  let node = opts.node;
  if (node === undefined) {
    node = interactive ? await ask("Target node id", DEFAULT_NODE) : DEFAULT_NODE;
  }

  let dockerfile = opts.dockerfile;
  if (dockerfile === undefined) {
    dockerfile = interactive ? await ask("Path to the service Dockerfile", "./Dockerfile") : "./Dockerfile";
  }

  let domain = opts.domain;
  let port = opts.port;
  if (domain === undefined && port === undefined && interactive) {
    const isWeb = await askYesNo("Does this service serve web traffic (needs a domain)?", true);
    if (isWeb) {
      domain = await ask("Public domain", `${name}.example.com`);
      port = positiveInt(await ask("Port your app listens on", String(DEFAULT_PORT)));
    }
  }

  const svc: ServiceValues = {
    name,
    node,
    dockerfile,
    cpu: opts.cpu ?? DEFAULT_CPU,
    memory: opts.memory ?? DEFAULT_MEMORY,
    ...(domain !== undefined && port !== undefined ? { domain, port } : {}),
  };

  return { project: name, svc };
}

async function runInit(opts: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const target = join(cwd, CONFIG_FILENAME);

  if (existsSync(target) && opts.force !== true) {
    throw new CliError(`${CONFIG_FILENAME} already exists in ${cwd}`, {
      hint: "pass --force to overwrite it",
    });
  }

  const { project, svc } = await gatherValues(opts, cwd);
  const toml = renderToml(project, svc);

  // Validate what we generated before writing it, so init can never emit an
  // invalid config.
  try {
    parseLaunchPadConfig(parseToml(toml));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new CliError(`generated config failed validation:\n${formatZodError(error)}`, {
        hint: "this is a bug — please check the flags you passed",
      });
    }
    throw error;
  }

  if (!LABEL_REGEX.test(project)) {
    throw new CliError(`invalid project name "${project}"`);
  }

  writeFileSync(target, toml, "utf8");

  if (isJsonMode()) {
    printJson({ path: target, project, service: svc });
    return;
  }

  log.success(`wrote ${color.cyan(CONFIG_FILENAME)}`);
  log.plain();
  for (const line of toml.trimEnd().split("\n")) {
    log.dim(`  ${line}`);
  }

  const kind = svc.domain ? "web service" : "worker";
  panel("Next steps", [
    `${color.dim("1.")} review ${color.cyan(CONFIG_FILENAME)} ${color.dim(`(${kind} on ${svc.node})`)}`,
    `${color.dim("2.")} create the node:  ${color.cyan(`launch-pad node create ${svc.node}`)}`,
    `${color.dim("3.")} deploy:           ${color.cyan("launch-pad deploy")}`,
  ]);
}

export function registerInit(program: Command): void {
  const cmd = program
    .command("init")
    .description("Create a launch-pad.toml in the current directory")
    .option("--name <name>", "project + service name")
    .option("--node <nodeId>", "target node id")
    .option("--domain <domain>", "public domain (makes this a web service)")
    .option("--port <port>", "container port the app listens on", positiveInt)
    .option("--dockerfile <path>", "path to the service Dockerfile")
    .option("--cpu <shares>", "cpu in vCPU shares (1024 = 1 vCPU)", positiveInt)
    .option("--memory <mb>", "memory in MB", positiveInt)
    .option("-f, --force", "overwrite an existing launch-pad.toml")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ launch-pad init",
        "  $ launch-pad init --name blog --node node-prod-1 --domain blog.me.com --port 3000",
        "  $ launch-pad init --name worker --node node-prod-1   # no domain → worker",
      ].join("\n"),
    )
    .action(async (opts: InitOptions) => {
      await runInit(opts);
    });

  applyGlobalOptions(cmd);
}
