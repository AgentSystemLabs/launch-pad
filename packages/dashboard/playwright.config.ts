import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PORT, FAKE_CLI, HOME_PATH, STATE_PATH } from "./tests/paths";

export default defineConfig({
  testDir: "./tests/e2e",
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
  globalSetup: "./tests/global-setup.ts",
  webServer: {
    command: "bun run build:tailwind && bun src/index.tsx",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(E2E_PORT),
      LAUNCH_PAD_BIN: FAKE_CLI,
      FAKE_LP_STATE: STATE_PATH,
      LAUNCH_PAD_DASHBOARD_HOME: HOME_PATH,
      LAUNCH_PAD_DASHBOARD_HOST: "127.0.0.1",
    },
  },
});
