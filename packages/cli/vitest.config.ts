import { defineConfig } from "vitest/config";

// Explicit include so vitest never collects the Playwright dashboard specs
// (e2e/**/*.spec.ts) — those run via `pnpm test:e2e` under @playwright/test.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
