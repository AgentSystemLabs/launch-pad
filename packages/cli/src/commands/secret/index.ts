import { Command } from "commander";
import {
  envProject,
  LABEL_REGEX,
  SECRET_KEY_REGEX,
  secretParameterPath,
  secretParameterPrefix,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import {
  deleteSecretParameter,
  listSecretsByPrefix,
  putSecretParameter,
} from "../../aws/ssm-secrets";
import { findConfigPath, loadConfig } from "../../config/load";
import {
  readServiceSecrets,
  registerServiceSecret,
  unregisterServiceSecret,
} from "../../config/toml-secrets";
import { CliError } from "../../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../../globals";
import { isJsonMode, log, printJson } from "../../ui/log";
import { promptSecret } from "../../ui/prompt";
import { color } from "../../ui/theme";

interface SecretOptions extends GlobalOpts {
  service?: string;
  env?: string;
  noRegister?: boolean;
  value?: string;
}

interface SecretContext {
  aws: AwsEnv;
  project: string;
  service: string;
  ownerProject: string;
  prefix: string;
  cwd: string;
}

function assertSecretKey(key: string): void {
  if (!SECRET_KEY_REGEX.test(key)) {
    throw new CliError(`invalid secret key "${key}"`, {
      hint: "use env-var style names like DATABASE_URL or STRIPE_SECRET_KEY",
    });
  }
}

async function resolveSecretContext(opts: SecretOptions, requireService: boolean): Promise<SecretContext> {
  const cwd = process.cwd();
  if (!findConfigPath(cwd)) {
    throw new CliError("no launch-pad.toml found", {
      hint: "run from your project directory (or a parent)",
    });
  }
  const { config } = loadConfig();

  if (opts.env !== undefined && !LABEL_REGEX.test(opts.env)) {
    throw new CliError(`invalid --env "${opts.env}"`, {
      hint: "use lowercase letters, numbers and hyphens (a valid DNS label)",
    });
  }

  let serviceName = opts.service;
  if (!serviceName) {
    if (requireService) {
      throw new CliError("--service is required", {
        hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
      });
    }
    if (config.service.length === 1) {
      serviceName = config.service[0]!.name;
    } else {
      throw new CliError("--service is required when launch-pad.toml has multiple services", {
        hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
      });
    }
  }

  const decl = config.service.find((s) => s.name === serviceName);
  if (!decl) {
    throw new CliError(`no service named "${serviceName}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }

  const aws = await prepareAws(opts);
  const ownerProject = envProject(config.project, opts.env);
  const prefix = secretParameterPrefix({
    clusterId: aws.clusterId,
    ownerProject,
    service: serviceName,
  });

  return {
    aws,
    project: config.project,
    service: serviceName,
    ownerProject,
    prefix,
    cwd,
  };
}

async function readSecretValue(opts: SecretOptions): Promise<string> {
  if (opts.value !== undefined) {
    if (opts.value.length === 0) {
      throw new CliError("secret value must not be empty", {
        hint: "pipe a value on stdin or omit --value to use a hidden prompt",
      });
    }
    return opts.value;
  }
  try {
    const value = await promptSecret("secret value");
    if (value.length === 0) {
      throw new CliError("secret value must not be empty");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "aborted") {
      throw new CliError("aborted");
    }
    throw error;
  }
}

async function runSet(key: string, opts: SecretOptions): Promise<void> {
  assertSecretKey(key);
  const ctx = await resolveSecretContext(opts, true);
  const value = await readSecretValue(opts);
  const path = secretParameterPath({
    clusterId: ctx.aws.clusterId,
    ownerProject: ctx.ownerProject,
    service: ctx.service,
    key,
  });

  await putSecretParameter(ctx.aws.ssm, path, value);

  let registered = false;
  if (opts.noRegister !== true) {
    registered = registerServiceSecret(ctx.cwd, ctx.service, key);
  }

  if (isJsonMode()) {
    printJson({
      set: key,
      service: ctx.service,
      ownerProject: ctx.ownerProject,
      path,
      registered,
    });
    return;
  }

  log.success(`set secret ${color.cyan(key)} for service ${color.cyan(ctx.service)}`);
  log.dim(`  ${path}`);
  if (registered) {
    log.dim(`  registered in launch-pad.toml — run ${color.cyan("launch-pad deploy")} to apply`);
  } else if (opts.noRegister) {
    log.dim("  not registered in launch-pad.toml (--no-register)");
  } else {
    log.dim(`  already registered — run ${color.cyan("launch-pad deploy")} to apply`);
  }
  log.dim(`  rotate with ${color.cyan(`launch-pad deploy --restart --service ${ctx.service}`)}`);
}

async function runList(opts: SecretOptions): Promise<void> {
  const ctx = await resolveSecretContext(opts, false);
  const listed = await listSecretsByPrefix(ctx.aws.ssm, ctx.prefix);
  const registered = new Set(readServiceSecrets(ctx.cwd, ctx.service));

  if (isJsonMode()) {
    printJson({
      service: ctx.service,
      ownerProject: ctx.ownerProject,
      prefix: ctx.prefix,
      secrets: listed.map((s) => ({
        name: s.name,
        path: s.path,
        registered: registered.has(s.name),
      })),
    });
    return;
  }

  log.plain();
  log.plain(`  ${color.cyan(ctx.service)}  ${color.dim(ctx.prefix)}`);
  if (listed.length === 0) {
    log.dim("  no secrets in SSM yet");
    log.dim(`  set one with: ${color.cyan(`launch-pad secret set DATABASE_URL --service ${ctx.service}`)}`);
  } else {
    for (const s of listed) {
      const reg = registered.has(s.name) ? color.green("registered") : color.yellow("not in toml");
      log.plain(`  ${color.cyan(s.name)}  ${reg}`);
    }
  }
  log.plain();
}

async function runRm(key: string, opts: SecretOptions): Promise<void> {
  assertSecretKey(key);
  const ctx = await resolveSecretContext(opts, true);
  const path = secretParameterPath({
    clusterId: ctx.aws.clusterId,
    ownerProject: ctx.ownerProject,
    service: ctx.service,
    key,
  });

  await deleteSecretParameter(ctx.aws.ssm, path);

  let unregistered = false;
  if (opts.noRegister !== true) {
    unregistered = unregisterServiceSecret(ctx.cwd, ctx.service, key);
  }

  if (isJsonMode()) {
    printJson({
      removed: key,
      service: ctx.service,
      path,
      unregistered,
    });
    return;
  }

  log.success(`removed secret ${color.cyan(key)} from SSM`);
  if (unregistered) {
    log.dim(`  unregistered from launch-pad.toml`);
  }
  log.warn("if this secret is still deployed, remove it from running containers with deploy");
}

export function registerSecret(program: Command): void {
  const secret = program
    .command("secret")
    .description("Manage per-service secrets in SSM Parameter Store");

  const set = secret
    .command("set <key>")
    .description("Store a secret value in SSM and register the key in launch-pad.toml")
    .requiredOption("--service <name>", "service name from launch-pad.toml")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--value <value>", "secret value (prefer stdin or hidden prompt)")
    .option("--no-register", "write SSM only — do not modify launch-pad.toml")
    .action(async (key: string, _opts, command: Command) => {
      await runSet(key, mergedOpts<SecretOptions>(command));
    });
  applyGlobalOptions(set);

  const list = secret
    .command("list")
    .description("List secret names for a service (never prints values)")
    .option("--service <name>", "service name (required when multiple services)")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .action(async (_opts, command: Command) => {
      await runList(mergedOpts<SecretOptions>(command));
    });
  applyGlobalOptions(list);

  const rm = secret
    .command("rm <key>")
    .description("Delete a secret from SSM and unregister it from launch-pad.toml")
    .requiredOption("--service <name>", "service name from launch-pad.toml")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--no-register", "delete SSM only — do not modify launch-pad.toml")
    .action(async (key: string, _opts, command: Command) => {
      await runRm(key, mergedOpts<SecretOptions>(command));
    });
  applyGlobalOptions(rm);
}
