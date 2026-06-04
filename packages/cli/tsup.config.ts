import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  // Bundle the workspace `shared` package into the CLI so the published binary is
  // self-contained; everything else stays external and resolves from node_modules.
  noExternal: ["@agentsystemlabs/launch-pad-shared"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
