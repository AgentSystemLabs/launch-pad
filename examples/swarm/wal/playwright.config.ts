import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 8772);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `swarm-pw-${process.pid}.db`);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts", // bun tests are *.test.ts; keep them out of Playwright
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: BASE_URL },
  webServer: {
    command: "bun run build:tailwind && bun src/index.ts",
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { PORT: String(PORT), SWARM_DB: DB, WAL_HOST: "127.0.0.1" },
  },
});
