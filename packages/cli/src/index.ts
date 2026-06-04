import { Command } from "commander";
import { renderBanner } from "./banner";
import { registerDeploy } from "./commands/deploy";
import { registerInit } from "./commands/init";
import { registerNode } from "./commands/node";
import { registerStatus } from "./commands/status";
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
  .option("--json", "machine-readable JSON output (suppresses banner + spinners)")
  .option("--verbose", "verbose output, including stack traces on error")
  .option("--no-color", "disable colored output")
  .showHelpAfterError("(add --help for usage)")
  .addHelpText("beforeAll", () => (process.stderr.isTTY ? renderBanner(version) : ""));

program.hook("preAction", (_thisCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals() as GlobalOpts;
  if (program.opts<GlobalOpts>().color === false) configureColor(false);
  if (opts.json) setJsonMode(true);
  if (!opts.json && process.stderr.isTTY) {
    process.stderr.write(renderBanner(version));
  }
});

registerInit(program);
registerDeploy(program);
registerStatus(program);
registerNode(program);

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
