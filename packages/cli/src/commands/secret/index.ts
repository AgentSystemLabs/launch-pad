import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  footprintOwner,
  LABEL_REGEX,
  SECRET_KEY_HINT,
  SECRET_KEY_REGEX,
  secretParameterPath,
  secretParameterPrefix,
} from "@agentsystemlabs/launch-pad-shared";
import { type AwsEnv, prepareAws } from "../../aws/context";
import {
  deleteSecretParameter,
  getExistingSecretPaths,
  getSecretParameter,
  listSecretsByPrefix,
  putSecretParameter,
} from "../../aws/ssm-secrets";
import { parseDotenv, partitionSecretImportEntries } from "../../config/dotenv";
import { findConfigPath, loadConfig } from "../../config/load";
import {
  readServiceSecrets,
  registerServiceSecret,
  registerServiceSecrets,
  unregisterServiceSecret,
} from "../../config/toml-secrets";
import { CliError } from "../../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../../globals";
import { isJsonMode, log, printJson } from "../../ui/log";
import { promptSecret } from "../../ui/prompt";
import { color } from "../../ui/theme";
import {
  formatSecretOutput,
  parseSecretFormat,
  type SecretOutputFormat,
} from "./format";

interface SecretOptions extends GlobalOpts {
  service?: string;
  env?: string;
  noRegister?: boolean;
  value?: string;
}

interface SecretImportOptions extends SecretOptions {
  dryRun?: boolean;
}

interface SecretGetOptions extends SecretOptions {
  format?: string;
  quiet?: boolean;
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
  const ownerProject = footprintOwner(config, opts.env);
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
    log.dim(`  registered in launch-pad.toml — run ${color.cyan("launchpad deploy")} to apply`);
  } else if (opts.noRegister) {
    log.dim("  not registered in launch-pad.toml (--no-register)");
  } else {
    log.dim(`  already registered — run ${color.cyan("launchpad deploy")} to apply`);
  }
  log.dim(`  rotate with ${color.cyan(`launchpad deploy --restart --service ${ctx.service}`)}`);
}

function assertSecretFormat(raw: string | undefined): SecretOutputFormat {
  try {
    return parseSecretFormat(raw);
  } catch {
    throw new CliError(`invalid --format "${raw}"`, {
      hint: "use value, shell, or json",
    });
  }
}

async function runGet(key: string, opts: SecretGetOptions): Promise<void> {
  assertSecretKey(key);
  const ctx = await resolveSecretContext(opts, true);
  const format = assertSecretFormat(opts.format);
  const path = secretParameterPath({
    clusterId: ctx.aws.clusterId,
    ownerProject: ctx.ownerProject,
    service: ctx.service,
    key,
  });

  const value = await getSecretParameter(ctx.aws.ssm, path);
  if (value === null) {
    throw new CliError(`secret ${key} is not set for service ${ctx.service}`, {
      hint: `set it with ${color.cyan(`launchpad secret set ${key} --service ${ctx.service}`)}`,
    });
  }

  const output = formatSecretOutput(key, value, format);
  if (opts.quiet !== true && format === "value" && !isJsonMode()) {
    log.warn(
      `printing secret value to stdout — avoid logs/CI artifacts; prefer --format shell in scripts`,
    );
  }

  if (isJsonMode()) {
    printJson({
      key,
      service: ctx.service,
      ownerProject: ctx.ownerProject,
      path,
      format,
      value,
    });
    return;
  }

  process.stdout.write(`${output}\n`);
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
    log.dim(`  set one with: ${color.cyan(`launchpad secret set DATABASE_URL --service ${ctx.service}`)}`);
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

function readEnvFile(file: string): string {
  try {
    // `-` reads stdin so values can be piped in CI without a temp file on disk.
    return file === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new CliError(`file not found: ${file}`, {
        hint: "pass a path to a .env-style file (or - to read stdin)",
      });
    }
    throw error;
  }
}

async function runImport(file: string, opts: SecretImportOptions): Promise<void> {
  const plan = partitionSecretImportEntries(parseDotenv(readEnvFile(file)));

  // Reject-all: validate the entire file before any write so an import never
  // leaves a partial set of secrets behind.
  const problems: string[] = [];
  for (const line of plan.malformed) problems.push(`  line ${line}: not a KEY=VALUE assignment`);
  for (const e of plan.invalidKeys) {
    problems.push(`  line ${e.line}: invalid key "${e.key}" — must be ${SECRET_KEY_HINT}`);
  }
  for (const e of plan.emptyValues) {
    problems.push(`  line ${e.line}: "${e.key}" has an empty value (SSM can't store empty secrets)`);
  }
  if (problems.length > 0) {
    throw new CliError(
      `cannot import ${file}: ${problems.length} invalid ${problems.length === 1 ? "entry" : "entries"}`,
      { hint: `fix these lines and re-run — nothing was written:\n${problems.join("\n")}` },
    );
  }
  if (plan.valid.length === 0) {
    throw new CliError(`no secrets found in ${file}`, {
      hint: "the file has no KEY=VALUE lines",
    });
  }

  const ctx = await resolveSecretContext(opts, true);
  const targets = plan.valid.map((s) => ({
    ...s,
    path: secretParameterPath({
      clusterId: ctx.aws.clusterId,
      ownerProject: ctx.ownerProject,
      service: ctx.service,
      key: s.key,
    }),
  }));

  // Read-only existence check (no decryption) to label created vs. updated.
  const existing = await getExistingSecretPaths(
    ctx.aws.ssm,
    targets.map((t) => t.path),
  );
  const createdKeys = targets.filter((t) => !existing.has(t.path)).map((t) => t.key);
  const updatedKeys = targets.filter((t) => existing.has(t.path)).map((t) => t.key);

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({
        dryRun: true,
        service: ctx.service,
        ownerProject: ctx.ownerProject,
        env: opts.env ?? null,
        prefix: ctx.prefix,
        wouldCreate: createdKeys,
        wouldUpdate: updatedKeys,
        duplicates: plan.duplicates,
      });
      return;
    }
    log.plain();
    log.step(`would import ${targets.length} secret(s) into ${color.cyan(ctx.service)}${envLabel(opts.env)}`);
    log.dim(`  ${ctx.prefix}`);
    log.dim(`  ${createdKeys.length} new, ${updatedKeys.length} overwritten — nothing written (--dry-run)`);
    for (const t of targets) {
      const mark = existing.has(t.path) ? color.yellow("overwrite") : color.green("create");
      log.plain(`  ${mark}  ${color.cyan(t.key)}`);
    }
    warnDuplicates(plan.duplicates);
    log.plain();
    return;
  }

  // The put loop isn't transactional. If a write fails partway (throttling, IAM,
  // KMS), tell the user exactly which keys landed (names only) so they can reconcile
  // — re-running the same import is safe because puts overwrite idempotently.
  const written: string[] = [];
  try {
    for (const t of targets) {
      await putSecretParameter(ctx.aws.ssm, t.path, t.value);
      written.push(t.key);
    }
  } catch (error) {
    const remaining = targets.slice(written.length).map((t) => t.key);
    // Surface the SSM error CODE (`error.name`, e.g. ThrottlingException), not the
    // raw SDK message — that's an unvetted third-party string adjacent to the secret
    // value we just tried to PUT. The full message is still available under --verbose.
    const cause =
      error instanceof Error ? (opts.verbose ? error.message : error.name) : String(error);
    throw new CliError(
      `import failed after writing ${written.length}/${targets.length} secret(s) to SSM`,
      {
        hint: [
          `written: ${written.join(", ") || "(none)"}`,
          `not written: ${remaining.join(", ")}`,
          "nothing was registered in launch-pad.toml; re-run the same import to finish (overwrites are safe).",
          `cause: ${cause}`,
        ].join("\n"),
      },
    );
  }

  // Register AFTER the SSM writes succeed so the TOML never references a secret
  // that failed to land — and in one rewrite so a bulk import can't half-update it.
  let registered = 0;
  if (opts.noRegister !== true) {
    registered = registerServiceSecrets(
      ctx.cwd,
      ctx.service,
      targets.map((t) => t.key),
    ).length;
  }

  if (isJsonMode()) {
    printJson({
      imported: targets.length,
      service: ctx.service,
      ownerProject: ctx.ownerProject,
      env: opts.env ?? null,
      prefix: ctx.prefix,
      created: createdKeys,
      updated: updatedKeys,
      registered,
      duplicates: plan.duplicates,
    });
    return;
  }

  log.success(
    `imported ${targets.length} secret(s) into service ${color.cyan(ctx.service)}${envLabel(opts.env)}`,
  );
  log.dim(`  ${createdKeys.length} created, ${updatedKeys.length} updated`);
  log.dim(`  ${ctx.prefix}`);
  if (opts.noRegister) {
    log.dim("  not registered in launch-pad.toml (--no-register)");
  } else {
    log.dim(
      `  registered ${registered} new key(s) in launch-pad.toml — run ${color.cyan("launchpad deploy")} to apply`,
    );
    log.dim(
      `  a registered key is required by EVERY environment's deploy — import the matching .env into each --env`,
    );
  }
  warnDuplicates(plan.duplicates);
  log.dim(`  rotate with ${color.cyan(`launchpad deploy --restart --service ${ctx.service}`)}`);
}

function envLabel(env: string | undefined): string {
  return env ? ` (env: ${env})` : "";
}

function warnDuplicates(duplicates: string[]): void {
  if (duplicates.length === 0) return;
  log.warn(`duplicate keys in file (last value won): ${duplicates.join(", ")}`);
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

  const imp = secret
    .command("import <file>")
    .description("Bulk-import secrets from a .env-style file into SSM (per service + env)")
    .requiredOption("--service <name>", "service name from launch-pad.toml")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--no-register", "write SSM only — do not modify launch-pad.toml")
    .option("--dry-run", "show what would be imported (names only) without writing")
    .action(async (file: string, _opts, command: Command) => {
      await runImport(file, mergedOpts<SecretImportOptions>(command));
    });
  applyGlobalOptions(imp);

  const list = secret
    .command("list")
    .description("List secret names for a service (never prints values)")
    .option("--service <name>", "service name (required when multiple services)")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .action(async (_opts, command: Command) => {
      await runList(mergedOpts<SecretOptions>(command));
    });
  applyGlobalOptions(list);

  const get = secret
    .command("get <key>")
    .description("Print a decrypted secret value (for local scripting — never log stdout)")
    .requiredOption("--service <name>", "service name from launch-pad.toml")
    .option("--env <name>", "environment footprint (same as deploy --env)")
    .option("--format <mode>", "output: value (default), shell (export KEY=…), or json", "value")
    .option("--quiet", "skip the stdout warning when printing raw values")
    .action(async (key: string, _opts, command: Command) => {
      await runGet(key, mergedOpts<SecretGetOptions>(command));
    });
  applyGlobalOptions(get);

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
