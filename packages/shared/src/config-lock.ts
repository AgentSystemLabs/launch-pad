import { z } from "zod";
import {
  DatabaseEngineSchema,
  type LaunchPadConfig,
  POSTGRES_VERSION_REGEX,
  type ServiceDatabase,
  type ServiceDecl,
  ServiceTopologySchema,
  type VolumeDecl,
  VolumeDeclSchema,
} from "./config";
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
   * fail to catch changes to that field. (cpu/memory/replicas/env/secrets/domain/domainPattern are
 * deliberately excluded from locking; see `lockedServiceView`.)
 */
export const ConfigBaselineSchema = z
  .object({
    version: z.literal(CONFIG_BASELINE_VERSION),
    project: z.string().min(1),
    // The component (federated multi-repo deploys). Optional so baselines written
    // before components existed still parse.
    component: z.string().min(1).optional(),
    domainPattern: z.string().min(1).optional(),
    services: z
      .array(
        z
          .object({
            name: z.string().min(1),
            // Legacy — node pinning was removed; baselines written before that may
            // still carry these. Parsed but ignored (stripped from the lock view).
            node: z.string().min(1).optional(),
            nodes: z.array(z.string().min(1)).min(1).optional(),
            edge: z.string().min(1).optional(),
            // Locked identity: a scheduled job can't change its cadence (or become a
            // long-running worker) without a fresh footprint. Optional so baselines
            // written before cron existed still parse.
            cron: z.string().min(1).optional(),
            // Legacy — `schedule` was removed; baselines written before that may still carry it.
            schedule: z.enum(["even", "capacity"]).optional(),
            // Legacy — `topology` was removed (the edge is always its own node);
            // optional so old baselines parse, ignored like the other legacy fields.
            topology: ServiceTopologySchema.optional(),
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
            secrets: z.array(z.string()).default([]),
            // Locked identity: a service's persistent volumes can't change after the
            // first deploy. Defaulted so baselines written before volumes existed parse.
            volumes: z.array(VolumeDeclSchema).default([]),
            // Locked identity for a managed database: engine + version. A major-version
            // change is a migration, not a config tweak. (The backup-target `databases`
            // list and the backup schedule/retention are operational and NOT snapshotted,
            // so they stay freely mutable.) Optional so non-database baselines parse.
            database: z
              .object({ engine: DatabaseEngineSchema, version: z.string().regex(POSTGRES_VERSION_REGEX) })
              .strict()
              .optional(),
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
    ...(decl.cron !== undefined ? { cron: decl.cron } : {}),
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
    secrets: [...(decl.secrets ?? [])],
    volumes: decl.volumes.map((v) => ({ ...v })),
    ...(decl.database !== undefined
      ? { database: { engine: decl.database.engine, version: decl.database.version } }
      : {}),
  };
}

/** Build a deterministic baseline snapshot from a parsed launch-pad.toml. */
export function snapshotConfigBaseline(config: LaunchPadConfig, lockedAt: string): ConfigBaseline {
  return {
    version: CONFIG_BASELINE_VERSION,
    project: config.project,
    ...(config.component !== undefined ? { component: config.component } : {}),
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
  secrets: string[];
  volumes: VolumeDecl[];
  /** Cron expression for a scheduled job (carried by desired.json). */
  cron?: string | undefined;
  /** Managed-database marker (engine/version), carried by desired.json. */
  database?: ServiceDatabase | undefined;
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
  /** Permit new [[service]] blocks (e.g. adding admin to an existing footprint). */
  allowNewServices?: boolean;
}

/**
 * The locked-IDENTITY view of a service: everything except the mutable post-deploy
 * fields and the removed legacy fields. `cpu`/`memory` (vertical scale),
 * `replicas` (horizontal scale), `env` (non-secret config), `secrets` (key
 * names; values live in SSM), `domain` (prod hostname), and `domainPattern`
 * (env hostname projection) may all change after the first deploy and are
 * stripped here; the removed `node`/`nodes`/`edge`/`schedule`/`topology` fields
 * are stripped because an old baseline may still carry them and they no longer
 * mean anything. Identity + ingress + rollout/health stay locked.
 */
function lockedServiceView(
  service: ConfigBaseline["services"][number],
  opts?: ConfigLockCompareOptions,
): Record<string, unknown> {
  const {
    cpu: _cpu,
    memory: _memory,
    secrets: _secrets,
    replicas: _replicas,
    env: _env,
    domain: _domain,
    domainPattern: _domainPattern,
    node: _node,
    nodes: _nodes,
    edge: _edge,
    schedule: _schedule,
    topology: _topology,
    ...locked
  } = service;
  if (opts?.baselineFromDesired) {
    // desired.json can't carry dockerfile/context, so they're unknowable
    // on the reconstructed side — drop from BOTH sides. (domainPattern is already
    // stripped above as a mutable field.)
    const {
      dockerfile: _dockerfile,
      context: _context,
      ...rest
    } = locked;
    return rest;
  }
  return locked;
}

/** Drop deploy-time env LaunchPad injects (not user-declared) before comparing. */
function declaredEnv(env: Record<string, string>): Record<string, string> {
  const { [LAUNCH_PAD_ENVIRONMENT]: _injected, ...rest } = env;
  return rest;
}

/**
 * Reconstruct a baseline-shaped snapshot from live desired.json on nodes. The
 * caller passes the logical `project` (+ `component`) from its own config — NOT
 * the derived footprint owner — because the footprints were already looked up BY
 * that owner, and `analyzeConfigChange` compares `project`/`component` against
 * the current config's logical values. (Storing the owner here used to falsely
 * trip "project changed" for any env-scoped footprint with no stored baseline.)
 */
export function baselineFromDeployedFootprints(
  identity: { project: string; component?: string | undefined },
  footprints: DeployedFootprint[],
  lockedAt: string,
): ConfigBaseline {
  return {
    version: CONFIG_BASELINE_VERSION,
    project: identity.project,
    ...(identity.component !== undefined ? { component: identity.component } : {}),
    services: footprints
      .map((f) => ({
        name: f.service,
        ...(f.cron !== undefined ? { cron: f.cron } : {}),
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
        secrets: [...f.secrets],
        volumes: f.volumes.map((v) => ({ ...v })),
        ...(f.database !== undefined
          ? { database: { engine: f.database.engine, version: f.database.version } }
          : {}),
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
 * The post-deploy mutability rule, stated once so every violation message and the
 * deploy hint stay in sync. Keep in lock-step with `lockedServiceView` — the fields
 * named here are exactly the ones it strips before comparing.
 */
export const CONFIG_LOCK_MUTABLE_HINT =
  "only cpu, memory, replicas, env, secrets, domain, and domainPattern may change after the initial deploy";

interface ServiceChangeOutcome {
  service: string;
  identityChanged: boolean;
}

/** Shared core for `findConfigLockViolations`. */
function analyzeConfigChange(
  baseline: ConfigBaseline,
  current: ConfigBaseline,
  opts?: ConfigLockCompareOptions,
): { preServiceViolations: ConfigLockViolation[]; outcomes: ServiceChangeOutcome[] } {
  const preServiceViolations: ConfigLockViolation[] = [];

  if (baseline.project !== current.project) {
    preServiceViolations.push({
      path: "project",
      message: `project changed from "${baseline.project}" to "${current.project}"`,
    });
  }

  if (baseline.component !== current.component) {
    const show = (c: string | undefined) => (c === undefined ? "(none)" : `"${c}"`);
    preServiceViolations.push({
      path: "component",
      message: `component changed from ${show(baseline.component)} to ${show(current.component)}`,
    });
  }

  // Project domainPattern is env-only projection — mutable like per-service domainPattern.

  const baseByName = new Map(baseline.services.map((s) => [s.name, s]));
  const curByName = new Map(current.services.map((s) => [s.name, s]));

  for (const name of baseByName.keys()) {
    if (!curByName.has(name)) {
      preServiceViolations.push({
        path: `service.${name}`,
        message: `service "${name}" was removed — ${CONFIG_LOCK_MUTABLE_HINT}`,
      });
    }
  }

  for (const name of curByName.keys()) {
    if (!baseByName.has(name)) {
      if (opts?.allowNewServices) continue;
      preServiceViolations.push({
        path: `service.${name}`,
        message: `service "${name}" was added — ${CONFIG_LOCK_MUTABLE_HINT}`,
      });
    }
  }

  const outcomes: ServiceChangeOutcome[] = [];
  for (const [name, base] of baseByName) {
    const cur = curByName.get(name);
    if (!cur) continue;

    // The view must be applied identically to both sides — dropping a field from
    // only one side would make every compare mismatch (a false lock violation).
    const identityChanged =
      stableJson(lockedServiceView(base, opts)) !== stableJson(lockedServiceView(cur, opts));

    outcomes.push({ service: name, identityChanged });
  }

  return { preServiceViolations, outcomes };
}

/**
 * Compare a stored baseline to the current config. Only the mutable post-deploy
 * fields (`cpu`, `memory`, `replicas`, `env`, `secrets`, `domain`, `domainPattern`) may
 * differ per service; every other field (including service count and names)
 * must match exactly.
 */
export function findConfigLockViolations(
  baseline: ConfigBaseline,
  current: ConfigBaseline,
  opts?: ConfigLockCompareOptions,
): ConfigLockViolation[] {
  const { preServiceViolations, outcomes } = analyzeConfigChange(baseline, current, opts);

  const violations = [...preServiceViolations];
  for (const o of outcomes) {
    if (o.identityChanged) {
      violations.push({
        path: `service.${o.service}`,
        message: `locked fields changed for service "${o.service}" — ${CONFIG_LOCK_MUTABLE_HINT}`,
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
