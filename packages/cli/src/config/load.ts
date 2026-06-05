import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ZodError } from "zod";
import {
  type LaunchPadConfig,
  parseLaunchPadConfig,
} from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

export const CONFIG_FILENAME = "launch-pad.toml";

export interface LoadedConfig {
  config: LaunchPadConfig;
  /** Absolute path to the launch-pad.toml that was loaded. */
  path: string;
  /** Directory containing the config (build contexts resolve relative to this). */
  dir: string;
}

/** Walk up from `startDir` looking for a launch-pad.toml. */
export function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Find, parse, and validate the launch-pad.toml. Throws CliError on any problem. */
export function loadConfig(startDir: string = process.cwd()): LoadedConfig {
  const path = findConfigPath(startDir);
  if (!path) {
    throw new CliError(`no ${CONFIG_FILENAME} found in ${startDir} or any parent directory`, {
      hint: "run `launch-pad init` to create one",
    });
  }

  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`failed to parse ${path}\n  ${(error as Error).message}`);
  }

  try {
    return { config: parseLaunchPadConfig(raw), path, dir: dirname(path) };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new CliError(`invalid ${CONFIG_FILENAME}:\n${formatZodError(error)}`);
    }
    if (error instanceof Error && error.message) {
      throw new CliError(`invalid ${CONFIG_FILENAME}:\n  ${error.message}`);
    }
    throw error;
  }
}
