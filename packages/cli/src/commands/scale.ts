import { Command } from "commander";
import { loadConfig } from "../config/load";
import {
  type NumericServiceField,
  readServiceNumericField,
  setServiceNumericField,
} from "../config/toml-edit";
import { CliError } from "../errors";
import { applyGlobalOptions, mergedOpts } from "../globals";
import { isJsonMode, log, printJson } from "../ui/log";
import { color } from "../ui/theme";
import { type EditDeployOptions, runEditDeploy } from "./edit-deploy";

interface ScaleOptions extends EditDeployOptions {
  /** Preview only — print the change, edit nothing, deploy nothing. */
  dryRun?: boolean;
}

/** Parse a whole-number count from a positional arg, or null when it isn't one. */
function parseCount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

const UNIT: Record<NumericServiceField, string> = {
  replicas: "",
  cpu: " vCPU shares",
  memory: " MB",
};

async function runScale(
  field: NumericServiceField,
  service: string,
  rawValue: string,
  opts: ScaleOptions,
): Promise<void> {
  const { config, dir } = loadConfig();
  const decl = config.service.find((s) => s.name === service);
  if (!decl) {
    throw new CliError(`no service named "${service}" in launch-pad.toml`, {
      hint: `available: ${config.service.map((s) => s.name).join(", ")}`,
    });
  }

  const value = parseCount(rawValue);
  if (value === null) {
    throw new CliError(`invalid ${field} "${rawValue}"`, {
      hint: field === "replicas" ? "pass a whole number >= 1, e.g. 3" : "pass a whole number of " + (field === "cpu" ? "vCPU shares (1024 = 1 vCPU)" : "MB"),
    });
  }

  // The currently-declared value (decl[field] carries the schema default when the
  // TOML omits it; readServiceNumericField returns undefined when truly absent).
  const declared = readServiceNumericField(dir, service, field);
  const effective = declared ?? decl[field];

  if (opts.dryRun) {
    if (isJsonMode()) {
      printJson({ dryRun: true, service, field, previous: effective, next: value });
    } else {
      log.step(
        `would set ${color.cyan(`${service}.${field}`)} ${effective}${UNIT[field]} → ${value}${UNIT[field]} and deploy`,
      );
    }
    return;
  }

  let edit;
  try {
    edit = setServiceNumericField(dir, service, field, value);
  } catch (error) {
    throw new CliError((error as Error).message, {
      hint: `valid ${field} values are whole numbers${field === "replicas" ? " >= 1" : " > 0"}`,
    });
  }

  if (opts.deploy === false) {
    if (isJsonMode()) {
      printJson({ scaled: false, deployed: false, service, ...edit });
      return;
    }
    log.success(
      `set ${color.cyan(`${service}.${field}`)} = ${value}${UNIT[field]} ${color.dim(`(was ${edit.previous ?? effective})`)}`,
    );
    log.dim(`  --no-deploy: edited launch-pad.toml only — run ${color.cyan("launch-pad deploy")} to apply`);
    return;
  }

  if (!isJsonMode()) {
    log.step(
      `scaling ${color.cyan(`${service}.${field}`)} ${edit.previous ?? effective}${UNIT[field]} → ${value}${UNIT[field]}`,
    );
  }

  // Apply through the real deploy path so capacity admission, the (now-permitting)
  // config lock, placement, and the convergence watch all run exactly as a normal
  // deploy. A --service deploy republishes only this service; the unchanged image
  // is reused (same content hash → ECR skip), so a replica/cpu/memory bump is fast.
  await runEditDeploy(service, opts);
}

export function registerScale(program: Command): void {
  const scale = program
    .command("scale")
    .description("Scale a service's replicas, cpu, or memory (edits launch-pad.toml + deploys)");

  for (const field of ["replicas", "cpu", "memory"] as const) {
    const valueName = field === "replicas" ? "count" : field === "cpu" ? "shares" : "mb";
    const leaf = scale
      .command(`${field} <service> <${valueName}>`)
      .description(
        field === "replicas"
          ? "Set the replica count for a service and roll it out"
          : `Set a service's ${field} (${field === "cpu" ? "vCPU shares, 1024 = 1 vCPU" : "MB"}) and roll it out`,
      )
      .option("--no-deploy", "edit launch-pad.toml only — do not deploy")
      .option("--no-wait", "don't wait for the agent to report convergence")
      .option("--timeout <seconds>", "how long to wait for convergence")
      .option("--yes", "skip confirmation prompts (e.g. for any provisioning a scale-up needs)")
      .option("--dry-run", "show the change without editing launch-pad.toml or deploying")
      .action(async (service: string, value: string, _opts, command: Command) => {
        await runScale(field, service, value, mergedOpts<ScaleOptions>(command));
      });
    applyGlobalOptions(leaf);
  }

  scale.addHelpText(
    "after",
    [
      "",
      "Scale wraps the config-lock-permitted fields: replicas (horizontal), cpu and",
      "memory (vertical). It edits launch-pad.toml in place, then runs `deploy --service",
      "<name>` so the change rolls out health-gated and zero-downtime. Use --no-deploy to",
      "edit only, or --dry-run to preview.",
      "",
      "Examples:",
      "  $ launch-pad scale replicas web 3",
      "  $ launch-pad scale cpu web 512 --yes",
      "  $ launch-pad scale memory worker 1024 --no-deploy",
    ].join("\n"),
  );
}
