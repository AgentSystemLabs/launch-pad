import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { type CompletionCommand, commandTree, generateCompletion } from "./generate";

/** A small synthetic CLI tree mirroring launch-pad's shape. */
function sampleProgram(): Command {
  const p = new Command();
  p.name("launch-pad").option("--cluster <name>", "target cluster").option("--json", "json output");
  p.command("deploy").description("Build and deploy the app").option("--yes", "skip prompts");
  const node = p.command("node").description("Manage nodes");
  node.command("create").description("Create a node");
  node.command("destroy").description("Destroy a node");
  return p;
}

const NAMES = ["launch-pad", "lpd"];

describe("commandTree", () => {
  it("extracts names, descriptions, nested subcommands, and long flags", () => {
    const tree = commandTree(sampleProgram());
    expect(tree.name).toBe("launch-pad");
    expect(tree.options).toContain("--cluster");
    expect(tree.options).toContain("--json");
    const names = tree.subcommands.map((c) => c.name).sort();
    expect(names).toEqual(["deploy", "node"]);
    const node = tree.subcommands.find((c) => c.name === "node")!;
    expect(node.subcommands.map((c) => c.name).sort()).toEqual(["create", "destroy"]);
  });
});

describe("generateCompletion", () => {
  const tree: CompletionCommand = commandTree(sampleProgram());

  it("bash: completes top-level commands, node subcommands, and globals for both bins", () => {
    const out = generateCompletion("bash", tree, NAMES);
    expect(out).toContain("deploy node"); // top-level command list (sorted)
    expect(out).toContain('case "$cmd" in');
    expect(out).toContain("create destroy"); // node subcommands
    expect(out).toContain("--cluster");
    expect(out).toContain("complete -F _launch_pad_complete launch-pad lpd");
  });

  it("zsh: emits a #compdef header, _describe blocks, and a per-subcommand case arm", () => {
    const out = generateCompletion("zsh", tree, NAMES);
    expect(out).toContain("#compdef launch-pad lpd");
    expect(out).toContain("'deploy:Build and deploy the app'");
    expect(out).toContain("node)");
    expect(out).toContain("'create:Create a node'");
    expect(out).toContain("compdef _launch_pad_complete launch-pad lpd");
  });

  it("fish: emits subcommand + sub-subcommand + global-flag completes for each bin", () => {
    const out = generateCompletion("fish", tree, NAMES);
    expect(out).toContain("complete -c launch-pad -n __fish_use_subcommand -a deploy");
    expect(out).toContain('complete -c launch-pad -n "__fish_seen_subcommand_from node" -a create');
    expect(out).toContain("complete -c launch-pad -l cluster");
    expect(out).toContain("complete -c lpd -n __fish_use_subcommand -a deploy"); // also for the alias bin
  });

  it("does not leak unescaped colons into zsh describe entries", () => {
    const p = new Command();
    p.name("x");
    p.command("foo").description("does a: thing with: colons");
    const out = generateCompletion("zsh", commandTree(p), ["x"]);
    // exactly one colon (the name:desc separator), not the ones from the description
    const line = out.split("\n").find((l) => l.includes("'foo:"))!;
    expect(line.match(/:/g)?.length).toBe(1);
  });
});
