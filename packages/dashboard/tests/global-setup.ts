import { rmSync } from "node:fs";
import { HOME_PATH, STATE_PATH } from "./paths";

/** Start each run from a clean slate: fresh fake-CLI seed + empty dashboard home. */
export default function globalSetup() {
  rmSync(STATE_PATH, { force: true });
  rmSync(HOME_PATH, { recursive: true, force: true });
}
