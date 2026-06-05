import type { Command } from "commander";

/** Options available on every command (defined on the root and each leaf so they
 * may appear before OR after the subcommand). `--no-color` lives only on the root
 * to avoid a negation-default clobbering the merged value. */
export interface GlobalOpts {
  profile?: string;
  region?: string;
  cluster?: string;
  json?: boolean;
  verbose?: boolean;
  color?: boolean;
}

/** Attach the shared global options to a leaf command. None carry a default, so an
 * unset flag is simply absent from `opts()` and `optsWithGlobals()` merges cleanly. */
export function applyGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "AWS profile to use")
    .option("--region <region>", "AWS region (defaults to your AWS config)")
    .option("--cluster <name>", "target cluster (defaults to your default cluster, else 'default')")
    .option("--json", "machine-readable JSON output (suppresses banner + spinners)")
    .option("--verbose", "verbose output, including stack traces on error");
}

/**
 * Read an action's options as MERGED globals. The global flags (`--profile`,
 * `--region`, `--cluster`, …) are declared on BOTH the root program and each leaf
 * so they can appear before or after the subcommand — but that means a leaf's
 * plain `.opts()` reports them as `undefined`. Only `optsWithGlobals()` carries the
 * value. Every action must read its options through this, never the leaf opts arg
 * commander passes, or those flags are silently dropped.
 */
export function mergedOpts<T extends GlobalOpts = GlobalOpts>(command: Command): T {
  return command.optsWithGlobals() as T;
}
