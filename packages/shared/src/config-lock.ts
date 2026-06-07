import { z } from "zod";
import { type LaunchPadConfig, type ServiceDecl } from "./config";
import { CONFIG_BASELINE_VERSION, LAUNCH_PAD_ENVIRONMENT } from "./constants";
import type { HealthCheck, Rollout } from "./health";
import { HealthCheckSchema, RolloutSchema } from "./health";
import type { Ingress } from "./desired";

/**
 * Frozen snapshot of launch-pad.toml written after the first successful deploy.
 *
 * ⚠️ The per-service shape below is a hand-maintained mirror of `ServiceDeclSchema`
 * (config.ts). The config lock can only forbid post-deploy changes to fields it
 * SNAPSHOTS — so if you add a field to `ServiceDeclSchema` that should be locked,
 * you MUST add it here AND to `serviceSnapshot` below, or the lock will silently
 * fail to catch changes to that field. (cpu/memory are deliberately excluded from
 * locking; see `lockedServiceView`.)
 */
export const ConfigBaselineSchema = z
  .object({
    version: z.literal(CONFIG_BASELINE_VERSION),
    project: z.string().min(1),
    domainPattern: z.string().min(1).optional(),
    services: z
      .array(
        z
          .object({
            name: z.string().min(1),
            node: z.string().min(1).optional(),
            nodes: z.array(z.string().min(1)).min(1).optional(),
            edge: z.string().min(1).optional(),
            dockerfile: z.string(),
            context: z.string(),
            replicas: z.number().int().min(1),
            cpu: z.number().int().positive(),
            memory: z.number().int().positive(),
            env: z.record(z.string(), z.string()),
            domain: z.string().min(1).optional(),
            domainPattern: z.string().min(1).optional(),
            port: z.number().int().min(1).max(65535).optional(),
            healthCheck: HealthCheckSchema.optional(),
            rollout: RolloutSchema,
          })
          .strict(),
      )
      .min(1),
    lockedAt: z.string(),
  })
  .strict();

export type ConfigBaseline = z.infer<typeof ConfigBaselineSchema>;

export function parseConfigBaseline(input: unknown): ConfigBaseline {
  return ConfigBaselineSchema.parse(input);
}

function serviceSnapshot(decl: ServiceDecl): ConfigBaseline["services"][number] {
  return {
    name: decl.name,
    ...(decl.node !== undefined ? { node: decl.node } : {}),
    ...(decl.nodes !== undefined ? { nodes: [...decl.nodes] } : {}),
    ...(decl.edge !== undefined ? { edge: decl.edge } : {}),
    dockerfile: decl.dockerfile,
    context: decl.context,
    replicas: decl.replicas,
    cpu: decl.cpu,
    memory: decl.memory,
    env: { ...decl.env },
    ...(decl.domain !== undefined ? { domain: decl.domain } : {}),
    ...(decl.domainPattern !== undefined ? { domainPattern: decl.domainPattern } : {}),
    ...(decl.port !== undefined ? { port: decl.port } : {}),
    // Mirror deploy's `healthCheck.port ?? port` resolution so a baseline snapshot
    // (raw TOML) compares equal to one reconstructed from desired.json (resolved port).
    ...(decl.healthCheck !== undefined
      ? { healthCheck: { ...decl.healthCheck, port: decl.healthCheck.port ?? decl.port } }
      : {}),
    rollout: { ...decl.rollout },
  };
}

/** Build a deterministic baseline snapshot from a parsed launch-pad.toml. */
export function snapshotConfigBaseline(config: LaunchPadConfig, lockedAt: string): ConfigBaseline {
  return {
    version: CONFIG_BASELINE_VERSION,
    project: config.project,
    ...(config.domainPattern !== undefined ? { domainPattern: config.domainPattern } : {}),
    services: [...config.service]
      .map(serviceSnapshot)
      .sort((a, b) => a.name.localeCompare(b.name)),
    lockedAt,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

export interface DeployedFootprint {
  service: string;
  nodeIds: string[];
  replicas: number;
  cpu: number;
  memory: number;
  env: Record<string, string>;
  ingress: Ingress | null;
  healthCheck: HealthCheck | null;
  rollout: Rollout;
}

export interface ConfigLockCompareOptions {
  /**
   * The baseline was reconstructed from each node's desired.json (no stored
   * baseline file). desired.json doesn't carry `dockerfile`, `context`, or
   * `domainPattern`, so those fields are dropped from BOTH sides of the compare —
   * otherwise an unchanged config would falsely trip the lock. They're enforced
   * again from the next deploy onward, once the baseline file exists.
   */
  baselineFromDesired?: boolean;
}

/** The locked-field view of a service: everything except the mutable cpu/memory. */
function lockedServiceView(
  service: ConfigBaseline["services"][number],
  opts?: ConfigLockCompareOptions,
): Record<string, unknown> {
  const { cpu: _cpu, memory: _memory, ...locked } = service;
  if (opts?.baselineFromDesired) {
    const { dockerfile: _dockerfile, context: _context, domainPattern: _dp, ...rest } = locked;
    return rest;
  }
  return locked;
}

/** Drop deploy-time env LaunchPad injects (not user-declared) before comparing. */
function declaredEnv(env: Record<string, string>): Record<string, string> {
  const { [LAUNCH_PAD_ENVIRONMENT]: _injected, ...rest } = env;
  return rest;
}

/** Reconstruct a baseline-shaped snapshot from live desired.json on nodes. */
export function baselineFromDeployedFootprints(
  ownerProject: string,
  footprints: DeployedFootprint[],
  lockedAt: string,
): ConfigBaseline {
  return {
    version: CONFIG_BASELINE_VERSION,
    project: ownerProject,
    services: footprints
      .map((f) => ({
        name: f.service,
        ...(f.nodeIds.length === 1 ? { node: f.nodeIds[0] } : { nodes: [...f.nodeIds].sort() }),
        ...(f.ingress?.edge ? { edge: f.ingress.edge } : {}),
        dockerfile: "",
        context: "",
        replicas: f.replicas,
        cpu: f.cpu,
        memory: f.memory,
        env: declaredEnv(f.env),
        ...(f.ingress?.domain ? { domain: f.ingress.domain } : {}),
        ...(f.ingress?.port ? { port: f.ingress.port } : {}),
        ...(f.healthCheck ? { healthCheck: { ...f.healthCheck } } : {}),
        rollout: { ...f.rollout },
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    lockedAt,
  };
}

export interface ConfigLockViolation {
  path: string;
  message: string;
}

/**
 * Compare a stored baseline to the current config. Only `cpu` and `memory` may
 * differ per service; every other field (including service count and names) must
 * match exactly.
 */
export function findConfigLockViolations(
  baseline: ConfigBaseline,
  current: ConfigBaseline,
  opts?: ConfigLockCompareOptions,
): ConfigLockViolation[] {
  const violations: ConfigLockViolation[] = [];

  if (baseline.project !== current.project) {
    violations.push({
      path: "project",
      message: `project changed from "${baseline.project}" to "${current.project}"`,
    });
  }

  // desired.json doesn't carry the project domainPattern, so skip it when the
  // baseline was reconstructed from it (re-enforced once a baseline file exists).
  if (
    !opts?.baselineFromDesired &&
    stableJson(baseline.domainPattern ?? null) !== stableJson(current.domainPattern ?? null)
  ) {
    violations.push({
      path: "domainPattern",
      message: "project domainPattern changed after the initial deploy",
    });
  }

  const baseByName = new Map(baseline.services.map((s) => [s.name, s]));
  const curByName = new Map(current.services.map((s) => [s.name, s]));

  for (const name of baseByName.keys()) {
    if (!curByName.has(name)) {
      violations.push({
        path: `service.${name}`,
        message: `service "${name}" was removed — only cpu and memory may change after the initial deploy`,
      });
    }
  }

  for (const name of curByName.keys()) {
    if (!baseByName.has(name)) {
      violations.push({
        path: `service.${name}`,
        message: `service "${name}" was added — only cpu and memory may change after the initial deploy`,
      });
    }
  }

  for (const [name, base] of baseByName) {
    const cur = curByName.get(name);
    if (!cur) continue;

    // The view must be applied identically to both sides — dropping a field from
    // only one side would make every compare mismatch (a false lock violation).
    if (stableJson(lockedServiceView(base, opts)) !== stableJson(lockedServiceView(cur, opts))) {
      violations.push({
        path: `service.${name}`,
        message: `locked fields changed for service "${name}" — only cpu and memory may change after the initial deploy`,
      });
    }
  }

  return violations;
}

/** Throws when any locked field changed. Error message lists every violation. */
export function assertConfigLockAllowed(
  baseline: ConfigBaseline,
  current: ConfigBaseline,
  opts?: ConfigLockCompareOptions,
): void {
  const violations = findConfigLockViolations(baseline, current, opts);
  if (violations.length === 0) return;

  const lines = violations.map((v) => `  ${v.path}: ${v.message}`);
  throw new Error(
    `launch-pad.toml has changes that are not allowed after the initial deploy:\n${lines.join("\n")}`,
  );
}
