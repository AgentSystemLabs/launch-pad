import { rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { HOME_PATH, STATE_PATH } from "../paths";

/**
 * Per-test isolation: drop the fake-CLI state (next spawn re-seeds defaults) and the
 * dashboard's project registry (next config read starts empty). The long-lived server
 * reads both from disk on each request, so deleting the files is enough.
 */
export function resetFakeState() {
  rmSync(STATE_PATH, { force: true });
  rmSync(HOME_PATH, { recursive: true, force: true });
}

/** Auto-accept native confirm() dialogs (destroy actions guard with confirm). */
export function acceptDialogs(page: Page) {
  page.on("dialog", (d) => d.accept());
}
