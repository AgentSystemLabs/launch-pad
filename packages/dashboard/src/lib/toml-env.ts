/**
 * Read/write service env in a project's launch-pad.toml. Env is the human source of
 * truth and is config-locked per service, so the dashboard edits the toml and then
 * runs `deploy` (which re-locks the baseline) — never writes desired.json directly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface TomlService {
  name: string;
  env: Record<string, string>;
}

function tomlPath(dir: string): string {
  return join(dir, "launch-pad.toml");
}

function serviceArray(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const s = doc.service;
  if (Array.isArray(s)) return s as Array<Record<string, unknown>>;
  if (s && typeof s === "object") return [s as Record<string, unknown>];
  return [];
}

export function readServices(dir: string): TomlService[] {
  const doc = parse(readFileSync(tomlPath(dir), "utf8")) as Record<string, unknown>;
  return serviceArray(doc).map((s) => ({
    name: String(s.name ?? ""),
    env:
      s.env && typeof s.env === "object" ? (s.env as Record<string, string>) : {},
  }));
}

export function writeServiceEnv(dir: string, serviceName: string, env: Record<string, string>): void {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  svc.env = env;
  writeFileSync(path, stringify(doc));
}

/** "KEY=value" lines → record. Blank lines and `#` comments are ignored. */
export function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) env[key] = line.slice(eq + 1).trim();
  }
  return env;
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}
