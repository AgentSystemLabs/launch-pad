/**
 * Dashboard-local persistence — the ONLY state the dashboard owns. AWS remains the
 * source of truth for what clusters/nodes/services exist; this only remembers the
 * operator's registered project directories so the UI can resolve a `cwd` for
 * `logs` / `history` (both need a launch-pad.toml).
 *
 * Registration happens at launch time (`launchpad dashboard --project <dir>`, plus
 * the cwd auto-registers when it holds a launch-pad.toml) — the read-only web UI
 * itself never writes this file.
 *
 * Stored at ~/.launch-pad-dashboard/config.json (override dir via
 * LAUNCH_PAD_DASHBOARD_HOME — used by tests to isolate state).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

export interface DashboardProject {
  /** display + identity key (unique) */
  name: string;
  /** absolute host path containing launch-pad.toml */
  dir: string;
  /** cluster this project deploys to (optional; falls back to the active cluster) */
  cluster?: string;
}

export interface DashboardConfig {
  defaultCluster?: string;
  profile?: string;
  region?: string;
  projects: DashboardProject[];
}

const EMPTY: DashboardConfig = { projects: [] };

export function configDir(): string {
  return process.env.LAUNCH_PAD_DASHBOARD_HOME?.trim() || join(homedir(), ".launch-pad-dashboard");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): DashboardConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DashboardConfig>;
    return {
      defaultCluster: parsed.defaultCluster,
      profile: parsed.profile,
      region: parsed.region,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    };
  } catch {
    // A corrupt config shouldn't brick the dashboard — start fresh in memory.
    return { ...EMPTY };
  }
}

export function saveConfig(cfg: DashboardConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

export function listProjects(): DashboardProject[] {
  return loadConfig().projects;
}

export function getProject(name: string): DashboardProject | undefined {
  return loadConfig().projects.find((p) => p.name === name);
}

/** Add or replace a project (keyed by name). Launch-time only — never from the web UI. */
export function upsertProject(project: DashboardProject): void {
  const cfg = loadConfig();
  const idx = cfg.projects.findIndex((p) => p.name === project.name);
  if (idx >= 0) cfg.projects[idx] = project;
  else cfg.projects.push(project);
  saveConfig(cfg);
}

export interface DirCheck {
  ok: boolean;
  reason?: string;
}

/** Validate a registered project dir: absolute, exists, and holds a launch-pad.toml. */
export function checkProjectDir(dir: string): DirCheck {
  if (!dir || !isAbsolute(dir)) return { ok: false, reason: "path must be absolute" };
  if (!existsSync(dir)) return { ok: false, reason: "directory does not exist" };
  if (!existsSync(join(dir, "launch-pad.toml"))) return { ok: false, reason: "no launch-pad.toml in directory" };
  return { ok: true };
}
