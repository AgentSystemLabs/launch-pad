import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_NUMERIC_FIELD_MIN } from "@agentsystemlabs/launch-pad-shared";
import { parse, stringify } from "smol-toml";

/**
 * Surgical edits to launch-pad.toml for the fields the config lock allows to
 * change after the first deploy. Sibling to `toml-secrets.ts` (which owns the
 * `secrets` key); these own `replicas`/`cpu`/`memory` and `env`. Each function
 * reads → mutates one service → writes the whole document back via smol-toml, so
 * the file is machine-edited (formatting may normalize). They never write when the
 * value is already what was requested, so a re-run causes no diff churn.
 */

function tomlPath(dir: string): string {
  return join(dir, "launch-pad.toml");
}

function serviceArray(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const s = doc.service;
  if (Array.isArray(s)) return s as Array<Record<string, unknown>>;
  if (s && typeof s === "object") return [s as Record<string, unknown>];
  return [];
}

function findService(doc: Record<string, unknown>, serviceName: string): Record<string, unknown> {
  const svc = serviceArray(doc).find((s) => String(s.name) === serviceName);
  if (!svc) throw new Error(`service "${serviceName}" not found in launch-pad.toml`);
  return svc;
}

/** The numeric service fields editable post-deploy (mirrors the config-lock allowlist). */
export type NumericServiceField = "replicas" | "cpu" | "memory";

/** Minimum allowed value per field — the SAME bounds the Zod schema enforces, so a
 * value this accepts can never be one the next deploy's `parseLaunchPadConfig` rejects. */
const NUMERIC_FIELD_MIN: Record<NumericServiceField, number> = SERVICE_NUMERIC_FIELD_MIN;

export interface NumericFieldEdit {
  field: NumericServiceField;
  /** The value declared before the edit, or undefined if it relied on a schema default. */
  previous: number | undefined;
  next: number;
  /** False when the declared value already equalled `next` (no write happened). */
  changed: boolean;
}

export interface EnvVarEdit {
  key: string;
  previous: string | undefined;
  /** The value after the edit, or undefined when the key was unset. */
  next: string | undefined;
  /** False when nothing changed (no write happened). */
  changed: boolean;
}

function readNumeric(svc: Record<string, unknown>, field: NumericServiceField): number | undefined {
  const raw = svc[field];
  return typeof raw === "number" ? raw : undefined;
}

/** Read a numeric field's declared value (undefined when it relies on a schema default). */
export function readServiceNumericField(
  dir: string,
  serviceName: string,
  field: NumericServiceField,
): number | undefined {
  const doc = parse(readFileSync(tomlPath(dir), "utf8")) as Record<string, unknown>;
  return readNumeric(findService(doc, serviceName), field);
}

/** Set `replicas`/`cpu`/`memory` on one service. Throws on a bad value or unknown service. */
export function setServiceNumericField(
  dir: string,
  serviceName: string,
  field: NumericServiceField,
  value: number,
): NumericFieldEdit {
  const min = NUMERIC_FIELD_MIN[field];
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}`);
  }
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = findService(doc, serviceName);
  const previous = readNumeric(svc, field);
  if (previous === value) {
    return { field, previous, next: value, changed: false };
  }
  svc[field] = value;
  writeFileSync(path, stringify(doc));
  return { field, previous, next: value, changed: true };
}

function envOf(svc: Record<string, unknown>): Record<string, string> {
  const raw = svc.env;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
}

/** Set a single env var on one service (creates the env table if absent). */
export function setServiceEnvVar(
  dir: string,
  serviceName: string,
  key: string,
  value: string,
): EnvVarEdit {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = findService(doc, serviceName);
  const env = envOf(svc);
  const previous = key in env ? env[key] : undefined;
  if (previous === value) {
    return { key, previous, next: value, changed: false };
  }
  svc.env = { ...env, [key]: value };
  writeFileSync(path, stringify(doc));
  return { key, previous, next: value, changed: true };
}

/** Remove a single env var from one service. No-op (changed=false) when absent. */
export function unsetServiceEnvVar(dir: string, serviceName: string, key: string): EnvVarEdit {
  const path = tomlPath(dir);
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const svc = findService(doc, serviceName);
  const env = envOf(svc);
  if (!(key in env)) {
    return { key, previous: undefined, next: undefined, changed: false };
  }
  const previous = env[key];
  const { [key]: _removed, ...rest } = env;
  svc.env = rest;
  writeFileSync(path, stringify(doc));
  return { key, previous, next: undefined, changed: true };
}
