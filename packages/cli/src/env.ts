import type { Command } from "commander";
import { log } from "./ui/log";

const PRODUCTION_ENV_ALIASES = new Set(["prod", "production"]);

/** True when `env` is a common mistaken name for the base (production) footprint. */
export function isProductionEnvAlias(env: string): boolean {
  return PRODUCTION_ENV_ALIASES.has(env.toLowerCase());
}

/**
 * Map `--env prod` / `--env production` to the base footprint (no env). The
 * alias string is returned when normalization happened so callers can warn.
 */
export function normalizeProductionEnvAlias(env: string | undefined): {
  env: string | undefined;
  alias: string | undefined;
} {
  if (env === undefined) return { env: undefined, alias: undefined };
  if (!isProductionEnvAlias(env)) return { env, alias: undefined };
  return { env: undefined, alias: env };
}

function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | undefined = cmd; c?.parent; c = c.parent ?? undefined) {
    parts.unshift(c.name());
  }
  return parts.join(" ");
}

/** Strip production env aliases from a leaf command before its action runs. */
export function applyProductionEnvAlias(command: Command): void {
  const opts = command.opts() as { env?: string };
  if (opts.env === undefined) return;

  const { env, alias } = normalizeProductionEnvAlias(opts.env);
  if (alias === undefined) return;

  command.setOptionValue("env", env);
  const where = commandPath(command);
  log.warn(
    `Ignoring --env ${alias}${where ? ` on ${where}` : ""}: production is the base footprint — omit --env.`,
  );
}
