import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // CJS + no splitting inlines the AWS SDK's dynamic imports into ONE file, so the
  // CLI can upload a single artifact that the node runs directly.
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "node22",
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});
