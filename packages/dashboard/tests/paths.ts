/** Shared paths/ports for the e2e harness (imported by playwright.config, global-setup, specs). */
import { join } from "node:path";

export const ROOT = process.cwd(); // playwright + webServer both run from the package dir
export const STATE_PATH = join(ROOT, "test-results", "fake-lp-state.json");
export const HOME_PATH = join(ROOT, "test-results", "dash-home");
export const FAKE_CLI = join(ROOT, "tests", "fake-cli", "launch-pad.ts");
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4599);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
