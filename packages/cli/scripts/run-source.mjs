#!/usr/bin/env node
/**
 * Dev launcher for globally-linked bins. Runs the CLI from TypeScript source via
 * tsx (honours packages/cli/tsconfig.json paths → shared/src) so you never need
 * to rebuild while hacking on launch-pad from another directory.
 *
 * The published npm package uses dist/index.js instead — this script is not shipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptsDir, "..");
const repoRoot = resolve(cliRoot, "../..");
const entry = join(cliRoot, "src/index.ts");
const tsconfig = join(cliRoot, "tsconfig.json");

function findTsx() {
  for (const candidate of [
    join(repoRoot, "node_modules/.bin/tsx"),
    join(cliRoot, "node_modules/.bin/tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "tsx";
}

const result = spawnSync(findTsx(), ["--tsconfig", tsconfig, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

if (result.error) {
  console.error(
    "launchpad dev launcher: could not run tsx — install deps with `pnpm install` in the launch-pad repo",
  );
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
