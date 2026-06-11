import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

function tomlPath(dir: string): string {
  return join(dir, "launch-pad.toml");
}

function serviceArray(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const s = doc.service;
  if (Array.isArray(s)) return s as Array<Record<string, unknown>>;
  if (s && typeof s === "object") return [s as Record<string, unknown>];
  return [];
}

function secretsOf(svc: Record<string, unknown>): string[] {
  const raw = svc.secrets;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x));
}

/** Read the `secrets` key list for one service. */
export function readServiceSecrets(dir: string, serviceName: string): string[] {
  const doc = parse(readFileSync(tomlPath(dir), "utf8")) as Record<string, unknown>;
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  return secretsOf(svc);
}

/** Append a secret key to a service's `secrets` array (no-op if already present). */
export function registerServiceSecret(dir: string, serviceName: string, key: string): boolean {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  const secrets = secretsOf(svc);
  if (secrets.includes(key)) return false;
  svc.secrets = [...secrets, key];
  writeFileSync(path, stringify(doc));
  return true;
}

/** Remove a secret key from a service's `secrets` array. */
export function unregisterServiceSecret(dir: string, serviceName: string, key: string): boolean {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  const secrets = secretsOf(svc);
  if (!secrets.includes(key)) return false;
  svc.secrets = secrets.filter((k) => k !== key);
  writeFileSync(path, stringify(doc));
  return true;
}
