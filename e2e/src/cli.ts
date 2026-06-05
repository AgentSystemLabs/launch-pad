import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const here = dirname(fileURLToPath(import.meta.url)); // e2e/src
export const repoRoot = resolve(here, "../..");
const CLI = resolve(repoRoot, "packages/cli/dist/index.js");

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  /** Don't throw on a non-zero exit (caller inspects exitCode). */
  allowFail?: boolean;
  /** Hard timeout in ms (default 25 min — covers provisioning + image pull). */
  timeout?: number;
}

export interface Cli {
  run(args: string[], opts?: RunOptions): Promise<CliResult>;
  json<T = unknown>(args: string[], opts?: RunOptions): Promise<T>;
}

const DEFAULT_TIMEOUT = 25 * 60_000;

/**
 * Build a CLI driver bound to an isolated LAUNCHPAD_HOME (so the user's real
 * `~/.launch-pad` is never touched) and an AWS region. Spawns the *built*
 * `dist/index.js` so the test exercises the artifact users run.
 */
export function makeCli(opts: { home: string; region: string; env?: Record<string, string> }): Cli {
  if (!existsSync(CLI)) {
    throw new Error(
      `built CLI not found at ${CLI}\n  run \`pnpm --filter @agentsystemlabs/launch-pad build\` first ` +
        "(the root `pnpm e2e` script does this automatically)",
    );
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LAUNCHPAD_HOME: opts.home,
    AWS_REGION: opts.region,
    AWS_DEFAULT_REGION: opts.region,
    FORCE_COLOR: "0",
    ...opts.env,
  };

  async function run(args: string[], runOpts: RunOptions = {}): Promise<CliResult> {
    const res = await execa("node", [CLI, ...args], {
      cwd: runOpts.cwd ?? repoRoot,
      env,
      reject: false,
      timeout: runOpts.timeout ?? DEFAULT_TIMEOUT,
      all: false,
    });
    const out: CliResult = {
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      exitCode: res.exitCode ?? 1,
    };
    if (!runOpts.allowFail && out.exitCode !== 0) {
      throw new Error(`\`launch-pad ${args.join(" ")}\` exited ${out.exitCode}\n${out.stderr}`);
    }
    return out;
  }

  async function json<T = unknown>(args: string[], runOpts: RunOptions = {}): Promise<T> {
    const res = await run([...args, "--json"], runOpts);
    try {
      return JSON.parse(res.stdout) as T;
    } catch {
      throw new Error(
        `expected JSON from \`launch-pad ${args.join(" ")}\` but got:\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
      );
    }
  }

  return { run, json };
}
