#!/usr/bin/env node
/** Run the compiled CLI (dist/). Used by `pnpm link:dist` to test the built artifact. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
if (!existsSync(dist)) {
  console.error("launchpad: dist/index.js missing — run `pnpm --filter @agentsystemlabs/launch-pad build` first");
  process.exit(1);
}

const result = spawnSync(process.execPath, [dist, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});
process.exit(result.status ?? 1);
