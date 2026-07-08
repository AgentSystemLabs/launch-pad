import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_PATH, STATE_PATH, TMP } from "./paths";

/** A real on-disk project dir (launch-pad.toml with `project = "shop"`) the
 * logs/history/projects specs register via the dashboard home config. */
export const PROJ_DIR = join(TMP, "proj-shop");

/** Start each run from a clean slate: fresh fake-CLI seed, empty dashboard home,
 * and a valid "shop" project directory for specs that register it. */
export default function globalSetup() {
  rmSync(STATE_PATH, { force: true });
  rmSync(HOME_PATH, { recursive: true, force: true });
  rmSync(PROJ_DIR, { recursive: true, force: true });
  mkdirSync(PROJ_DIR, { recursive: true });
  writeFileSync(join(PROJ_DIR, "launch-pad.toml"), 'project = "shop"\n\n[[service]]\nname = "api"\n');
}
