import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentsystemlabs/launch-pad-shared": resolve(__dirname, "../shared/src/index.ts"),
    },
  },
});
