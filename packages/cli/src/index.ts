import { Command } from "commander";
import { renderBanner, renderClusterLine } from "./banner";
import { registerBackup } from "./commands/backup";
import { registerCluster } from "./commands/cluster";
import { registerConfig } from "./commands/config";
import { registerCost } from "./commands/cost";
import { registerDeploy } from "./commands/deploy";
import { registerDns } from "./commands/dns";
import { registerDoctor } from "./commands/doctor";
import { registerHistory } from "./commands/history";
import { registerInit } from "./commands/init";
import { registerLogs } from "./commands/logs";
import { registerNode } from "./commands/node";
import { registerRebalance } from "./commands/rebalance";
import { registerRollback } from "./commands/rollback";
import { registerScale } from "./commands/scale";
import { registerSecret } from "./commands/secret";
import { registerSetup } from "./commands/setup";
import { registerStatus } from "./commands/status";
import { registerUndeploy } from "./commands/undeploy";
import { effectiveCluster } from "./config/local";
import { CliError } from "./errors";
import type { GlobalOpts } from "./globals";
import { log, setJsonMode } from "./ui/log";
import { configureColor } from "./ui/theme";
import { readVersion } from "./version";

const version = readVersion();
const program = new Command();

program
  .name("launch-pad")
  .description("Deploy your apps to your own AWS infrastructure — one command.")
  .version(version, "-V, --version", "print the version")
  // Global options are also defined on each leaf (see globals.ts) so they may
  // appear before or after the subcommand. `--no-color` lives only here.
  .option("--profile <name>", "AWS profile to use")
  .option("--region <region>", "AWS region (defaults to your AWS config)")
  .option("--cluster <name>", "target cluster (defaults to your default cluster, else 'default')")
  .option("--json", "machine-readable JSON output (suppresses banner + spinners)")
  .option("--verbose", "verbose output, including stack traces on error")
  .option("--no-color", "disable colored output")
  .showHelpAfterError("(add --help for usage)")
  .addHelpText("beforeAll", () => (process.stderr.isTTY ? renderBanner(version) : ""));

/** The full command path (e.g. "node create"), excluding the program name. */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | undefined = cmd; c && c.parent; c = c.parent ?? undefined) {
    parts.unshift(c.name());
  }
  return parts.join(" ");
}

/**
 * Commands that resolve their AWS target from the active cluster (`--cluster` →
 * `defaultCluster` → "default") get a one-line "cluster: <id>" banner so you always
 * know what you're targeting. `cluster` subcommands name their target explicitly (and
 * echo it themselves), and `init` is purely local — so neither shows the line.
 */
function showsClusterBanner(path: string): boolean {
  return (
    path === "deploy" ||
    path === "undeploy" ||
    path === "rollback" ||
    path === "rebalance" ||
    path === "status" ||
    path === "history" ||
    path === "logs" ||
    path.startsWith("scale") ||
    path.startsWith("config ") ||
    path.startsWith("dns ") ||
    path.startsWith("secret") ||
    path.startsWith("node ")
  );
}

program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals() as GlobalOpts;
  // `--no-color` is intentionally read from the ROOT program opts, NOT from the
  // merged `opts` above — it's a root-only global (see globals.ts). Do NOT
  // "consistency-fix" this to `opts.color`; the flag isn't on subcommands, so that
  // would silently always read undefined and break --no-color.
  if (program.opts<GlobalOpts>().color === false) configureColor(false);
  if (opts.json) setJsonMode(true);
  if (!opts.json && process.stderr.isTTY) {
    process.stderr.write(renderBanner(version));
    if (showsClusterBanner(commandPath(actionCommand))) {
      try {
        process.stderr.write(renderClusterLine(effectiveCluster(opts)));
      } catch {
        // The cluster line is decorative — a malformed local config surfaces when the
        // command actually resolves AWS; never let it break the banner itself.
      }
    }
  }
});

registerInit(program);
registerDoctor(program);
registerSetup(program);
registerDeploy(program);
registerUndeploy(program);
registerRollback(program);
registerRebalance(program);
registerScale(program);
registerConfig(program);
registerStatus(program);
registerHistory(program);
registerLogs(program);
registerSecret(program);
registerDns(program);
registerNode(program);
registerCluster(program);
registerBackup(program);
registerCost(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CliError) {
      log.error(error.message);
      if (error.hint) log.dim(`  ${error.hint}`);
      process.exitCode = error.exitCode;
      return;
    }
    log.error(error instanceof Error ? error.message : String(error));
    if (program.opts<GlobalOpts>().verbose && error instanceof Error && error.stack) {
      log.dim(error.stack);
    }
    process.exitCode = 1;
  }
}

void main();
