/** Shared paths/ports for the dashboard e2e harness (imported by
 * playwright.config, global-setup, and specs). Anchored to this file's location
 * so it never depends on the invoking cwd. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/cli — the package root (this file lives at packages/cli/e2e/paths.ts). */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Scratch dir for everything the harness writes (gitignored). */
export const TMP = join(ROOT, "e2e", ".tmp");
export const STATE_PATH = join(TMP, "fake-lp-state.json");
export const HOME_PATH = join(TMP, "dash-home");
export const FAKE_CLI = join(ROOT, "e2e", "fake-cli", "launch-pad.mjs");

export const E2E_PORT = Number(process.env.E2E_PORT ?? 4599);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
