import type { Command } from "commander";

/** Options available on every command (defined on the root and each leaf so they
 * may appear before OR after the subcommand). `--no-color` lives only on the root
 * to avoid a negation-default clobbering the merged value. */
export interface GlobalOpts {
  profile?: string;
  region?: string;
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
    .option("--json", "machine-readable JSON output (suppresses banner + spinners)")
    .option("--verbose", "verbose output, including stack traces on error");
}
