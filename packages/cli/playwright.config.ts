import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PORT, FAKE_CLI, HOME_PATH, STATE_PATH } from "./e2e/paths";

/**
 * Dashboard e2e harness: builds the CLI, runs `launchpad dashboard` against the
 * fake read-only CLI (e2e/fake-cli/launch-pad.mjs via LAUNCH_PAD_BIN), and drives
 * the pages with Playwright. `pnpm test:e2e` from packages/cli.
 */
export default defineConfig({
  testDir: "./e2e/specs",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // The fake CLI persists to one shared state file → run specs serially.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    // Build is idempotent; hide its (noisy) stdout but keep stderr for failures.
    command: `pnpm run build >/dev/null && node dist/index.js dashboard --no-open --port ${E2E_PORT}`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      LAUNCH_PAD_BIN: FAKE_CLI,
      FAKE_LP_STATE: STATE_PATH,
      LAUNCH_PAD_DASHBOARD_HOME: HOME_PATH,
      LAUNCH_PAD_DASHBOARD_HOST: "127.0.0.1",
    },
  },
});
