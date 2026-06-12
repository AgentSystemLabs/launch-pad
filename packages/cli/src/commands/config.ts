import { Command } from "commander";
import { loadConfig } from "../config/load";
import { type EnvVarEdit, setServiceEnvVar, unsetServiceEnvVar } from "../config/toml-edit";
import { CliError } from "../errors";
import { applyGlobalOptions, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";
import { type EditDeployOptions, runEditDeploy } from "./edit-deploy";

interface ConfigOptions extends EditDeployOptions {
  /** Preview only — print the change, edit nothing, deploy nothing. */
  dryRun?: boolean;
}

/** Standard env-var name: a letter or underscore, then letters/digits/underscores. */
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split a `KEY=VALUE` assignment (value may contain `=`; empty value is allowed). */
function parseAssignment(raw: string): { key: string; value: string } | null {
  const eq = raw.indexOf("=");
  if (eq <= 0) return null;
  return { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

function assertEnvKey(key: string): void {
  if (!ENV_KEY_REGEX.test(key)) {
    throw new CliError(`invalid env var name "${key}"`, {
      hint: "use a standard name: a letter or underscore, then letters, digits, or underscores (e.g. FEATURE_X)",
    });
  }
}

function resolveService(service: string): { dir: string } {
  const { config, dir } = loadConfig();
  const decl = config.service.find((s) => s.name === service);
  if (!decl) {
    throw new CliError(`no service named "${service}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }
  return { dir };
}

function reportEdit(edit: EnvVarEdit, service: string, opts: ConfigOptions): void {
  if (isJsonMode()) {
    printJson({ deployed: false, service, ...edit });
    return;
  }
  const verb = edit.next === undefined ? "unset" : "set";
  log.success(`${verb} ${color.cyan(`${service}.env.${edit.key}`)}`);
  if (opts.deploy === false) {
    log.dim(`  --no-deploy: edited launch-pad.toml only — run ${color.cyan("launchpad deploy")} to apply`);
  }
}

async function applyEdit(
  service: string,
  edit: EnvVarEdit,
  opts: ConfigOptions,
): Promise<void> {
  if (!edit.changed) {
    if (!isJsonMode()) log.dim(`  ${color.cyan(`${service}.env.${edit.key}`)} already at that value — nothing to do`);
    if (opts.deploy === false) {
      if (isJsonMode()) printJson({ deployed: false, service, ...edit });
      return;
    }
    // Even when the TOML didn't change, the value may not be deployed yet — fall
    // through to deploy so `config set` is reliably "make it so".
  } else if (opts.deploy === false) {
    reportEdit(edit, service, opts);
    return;
  } else if (!isJsonMode()) {
    reportEdit(edit, service, opts);
  }
  await runEditDeploy(service, opts);
}

async function runSet(service: string, assignment: string, opts: ConfigOptions): Promise<void> {
  const parsed = parseAssignment(assignment);
  if (!parsed) {
    throw new CliError(`invalid assignment "${assignment}"`, { hint: "use KEY=VALUE, e.g. FEATURE_X=on" });
  }
  assertEnvKey(parsed.key);
  const { dir } = resolveService(service);

  if (opts.dryRun) {
    if (isJsonMode()) printJson({ dryRun: true, service, set: parsed.key, value: parsed.value });
    else log.step(`would set ${color.cyan(`${service}.env.${parsed.key}`)} = ${parsed.value} and deploy`);
    return;
  }

  const edit = setServiceEnvVar(dir, service, parsed.key, parsed.value);
  await applyEdit(service, edit, opts);
}

async function runUnset(service: string, key: string, opts: ConfigOptions): Promise<void> {
  assertEnvKey(key);
  const { dir } = resolveService(service);

  if (opts.dryRun) {
    if (isJsonMode()) printJson({ dryRun: true, service, unset: key });
    else log.step(`would unset ${color.cyan(`${service}.env.${key}`)} and deploy`);
    return;
  }

  const edit = unsetServiceEnvVar(dir, service, key);
  await applyEdit(service, edit, opts);
}

function withEditDeployFlags(cmd: Command): Command {
  return cmd
    .option("--no-deploy", "edit launch-pad.toml only — do not deploy")
    .option("--no-wait", "don't wait for the agent to report convergence")
    .option("--timeout <seconds>", "how long to wait for convergence")
    .option("--yes", "skip confirmation prompts")
    .option("--dry-run", "show the change without editing launch-pad.toml or deploying");
}

export function registerConfig(program: Command): void {
  const config = program
    .command("config")
    .description("Edit non-secret env vars in launch-pad.toml (then deploy) — secrets live in `launchpad secret`");

  const set = withEditDeployFlags(
    config
      .command("set <service> <KEY=VALUE>")
      .description("Set an env var on a service and roll it out"),
  ).action(async (service: string, assignment: string, _opts, command: Command) => {
    await runSet(service, assignment, mergedOpts<ConfigOptions>(command));
  });
  applyGlobalOptions(set);

  const unset = withEditDeployFlags(
    config
      .command("unset <service> <KEY>")
      .description("Remove an env var from a service and roll it out"),
  ).action(async (service: string, key: string, _opts, command: Command) => {
    await runUnset(service, key, mergedOpts<ConfigOptions>(command));
  });
  applyGlobalOptions(unset);

  config.addHelpText(
    "after",
    [
      "",
      "`config` edits the `env` table of a [[service]] — the non-secret configuration the",
      "config lock allows to change after the first deploy. It writes launch-pad.toml then",
      "runs `deploy --service <name>` (health-gated, zero-downtime). For replicas/cpu/memory",
      "use `launchpad scale`; for secrets use `launchpad secret`.",
      "",
      "Examples:",
      "  $ launchpad config set web FEATURE_FLAGS=beta",
      "  $ launchpad config set web LOG_LEVEL=debug --yes",
      "  $ launchpad config unset web FEATURE_FLAGS --no-deploy",
    ].join("\n"),
  );
}
