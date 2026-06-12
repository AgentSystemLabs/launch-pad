import { Command } from "commander";
import { commandTree, generateCompletion, type Shell, SUPPORTED_SHELLS } from "../completions/generate";
import { CliError } from "../errors";

/** The CLI's binary names (see package.json `bin`) — all get completions. */
const BIN_NAMES = ["launchpad", "launch-pad", "lpd"];

function isShell(value: string): value is Shell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

export function registerCompletions(program: Command): void {
  program
    .command("completions <shell>")
    .description(`Print a shell-completion script (${SUPPORTED_SHELLS.join(" | ")})`)
    .addHelpText(
      "after",
      [
        "",
        "Generates a completion script for launchpad / lpd from the live command tree.",
        "Pipe it into the right place for your shell:",
        "",
        "  bash:  launchpad completions bash  >> ~/.bash_completion",
        "  zsh:   launchpad completions zsh   > \"${fpath[1]}/_launchpad\"   # then: compinit",
        "  fish:  launchpad completions fish  > ~/.config/fish/completions/launchpad.fish",
      ].join("\n"),
    )
    .action((shell: string) => {
      if (!isShell(shell)) {
        throw new CliError(`unsupported shell "${shell}"`, { hint: `supported: ${SUPPORTED_SHELLS.join(", ")}` });
      }
      // Introspect the fully-registered program tree so completions never drift from
      // the real commands. Strip `completions` itself from the suggestions — listing
      // the generator in tab-completion is noise.
      const tree = commandTree(program);
      tree.subcommands = tree.subcommands.filter((c) => c.name !== "completions");
      process.stdout.write(generateCompletion(shell, tree, BIN_NAMES));
    });
}
