import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJ_DIR } from "../global-setup";
import { HOME_PATH, STATE_PATH } from "../paths";

export { PROJ_DIR };

/**
 * Per-test isolation: drop the fake-CLI state (next spawn re-seeds defaults) and
 * the dashboard's home config (next read starts empty). The long-lived server
 * reads both from disk on each request, so deleting the files is enough.
 */
export function resetFakeState() {
  rmSync(STATE_PATH, { force: true });
  rmSync(HOME_PATH, { recursive: true, force: true });
}

interface HomeConfig {
  defaultCluster?: string;
  projects?: Array<{ name: string; dir: string; cluster?: string }>;
}

/** Seed the dashboard's home config (LAUNCH_PAD_DASHBOARD_HOME/config.json). */
export function seedHome(config: HomeConfig) {
  mkdirSync(HOME_PATH, { recursive: true });
  writeFileSync(join(HOME_PATH, "config.json"), JSON.stringify({ projects: [], ...config }));
}

/** Recreate the on-disk "shop" project dir (a spec may have clobbered it). */
export function ensureShopProjectDir(): string {
  mkdirSync(PROJ_DIR, { recursive: true });
  writeFileSync(join(PROJ_DIR, "launch-pad.toml"), 'project = "shop"\n\n[[service]]\nname = "api"\n');
  return PROJ_DIR;
}

/** Register the "shop" project (real dir + home config), like the old logs.spec. */
export function seedShopProject(extra: Omit<HomeConfig, "projects"> = {}) {
  ensureShopProjectDir();
  seedHome({ ...extra, projects: [{ name: "shop", dir: PROJ_DIR }] });
}
