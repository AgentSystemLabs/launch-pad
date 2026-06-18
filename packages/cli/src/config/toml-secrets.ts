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
  return registerServiceSecrets(dir, serviceName, [key]).length > 0;
}

/**
 * Append several secret keys to a service's `secrets` array in a single
 * read-modify-write (no-op for keys already present). Returns the keys that were
 * newly added. Used by `secret import` so a bulk import rewrites the TOML once and
 * can't leave it half-updated.
 */
export function registerServiceSecrets(dir: string, serviceName: string, keys: string[]): string[] {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  const secrets = secretsOf(svc);
  const present = new Set(secrets);
  const added: string[] = [];
  for (const key of keys) {
    if (present.has(key)) continue;
    present.add(key);
    added.push(key);
  }
  if (added.length === 0) return [];
  svc.secrets = [...secrets, ...added];
  writeFileSync(path, stringify(doc));
  return added;
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
