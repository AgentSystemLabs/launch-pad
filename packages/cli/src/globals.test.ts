import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "./globals";

/**
 * Regression guard for the bug where global flags (--profile/--region/--cluster) are
 * declared on BOTH the root program and the leaf, so the leaf's plain `.opts()`
 * reports them as undefined and the action silently drops them. Actions must read
 * `mergedOpts(command)` (optsWithGlobals), which works in both flag positions.
 */
function harness(captured: { merged?: GlobalOpts; leaf?: Record<string, unknown> }) {
  const program = new Command();
  // The root declares the same globals (so they may appear before the subcommand).
  program.option("--profile <name>").option("--region <r>").option("--cluster <name>").option("--json");
  const sub = program.command("go").option("--node <n>");
  sub.action((_opts, command: Command) => {
    captured.merged = mergedOpts(command);
    captured.leaf = command.opts();
  });
  applyGlobalOptions(sub);
  return program;
}

describe("mergedOpts", () => {
  it("captures --profile/--cluster passed AFTER the subcommand", () => {
    const c: { merged?: GlobalOpts; leaf?: Record<string, unknown> } = {};
    harness(c).parse(["node", "cli", "go", "--profile", "after-p", "--cluster", "lower"]);
    expect(c.merged?.profile).toBe("after-p");
    expect(c.merged?.cluster).toBe("lower");
  });

  it("captures --profile/--cluster passed BEFORE the subcommand", () => {
    const c: { merged?: GlobalOpts; leaf?: Record<string, unknown> } = {};
    harness(c).parse(["node", "cli", "--profile", "before-p", "--cluster", "prod", "go"]);
    expect(c.merged?.profile).toBe("before-p");
    expect(c.merged?.cluster).toBe("prod");
  });

  it("documents the trap: the leaf .opts() drops these flags (why mergedOpts exists)", () => {
    const c: { merged?: GlobalOpts; leaf?: Record<string, unknown> } = {};
    harness(c).parse(["node", "cli", "go", "--profile", "after-p"]);
    expect(c.leaf?.profile).toBeUndefined(); // the bug, if an action read this
    expect(c.merged?.profile).toBe("after-p"); // the fix
  });
});
