import { z } from "zod";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_DATABASE_CPU,
  DEFAULT_DATABASE_MEMORY,
  DEFAULT_POSTGRES_VERSION,
  LAUNCH_PAD_ENVIRONMENT,
  POSTGRES_DATA_PATH,
  POSTGRES_IMAGE_REPO,
  POSTGRES_PASSWORD_SECRET,
  POSTGRES_VOLUME_NAME,
} from "./constants";
import { cronExpressionError, nextCronFire, parseCronExpression } from "./cron";
import { HealthCheckSchema, RolloutSchema } from "./health";
import { SECRET_KEY_HINT, SECRET_KEY_REGEX } from "./secrets";

/** DNS/label-safe identifier: lowercase alphanumeric + hyphen, 1–40 chars. */
export const LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Separator between project and component in a derived footprint owner
 * (`componentOwner`). Forbidden inside `project`/`component` labels so the
 * derived owner can never be ambiguous. Owners are derived once and never
 * parsed back — the project index (`project-registry.ts`) is the mapping.
 */
export const COMPONENT_SEPARATOR = "--";

/**
 * Minimum allowed value for each numeric, post-deploy-mutable service field. The
 * single source of truth for these bounds — `ServiceDeclSchema` below enforces them
 * at parse time, and the CLI's `toml-edit` validates against them before it writes a
 * file deploy would only reject. Keep them tied here so the two can't drift.
 */
export const SERVICE_NUMERIC_FIELD_MIN = {
  replicas: 1,
  cpu: 1,
  memory: 1,
} as const satisfies Record<"replicas" | "cpu" | "memory", number>;

/** Node id: letters, digits, hyphens, underscores; 1–63 chars; starts with a letter or digit. */
export const NODE_ID_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62})?$/;

export const NODE_ID_HINT =
  "letters, numbers, hyphens, or underscores (1–63 chars; must start with a letter or number)";

/** Returns a validation message, or null when the node id is well formed. */
export function nodeIdError(id: string): string | null {
  if (!NODE_ID_REGEX.test(id)) return `must be ${NODE_ID_HINT}`;
  return null;
}

const label = (what: string) =>
  z.string().regex(LABEL_REGEX, `${what} must be lowercase letters, numbers and hyphens (1–40 chars)`);

/** Tokens a `domainPattern` may interpolate. `{env}` is required; `{service}` is optional. */
const DOMAIN_PATTERN_TOKENS = new Set(["env", "service"]);

/**
 * Validate a `domainPattern`. Returns an error message, or null when it's well
 * formed. A pattern MUST contain `{env}` (otherwise every environment would
 * collide on one host) and may only use the known tokens.
 */
export function domainPatternError(pattern: string): string | null {
  const tokens = [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  const unknown = tokens.filter((t) => !DOMAIN_PATTERN_TOKENS.has(t));
  if (unknown.length > 0) {
    return `domainPattern has unknown token(s) ${unknown.map((t) => `{${t}}`).join(", ")}; allowed: {env}, {service}`;
  }
  if (!tokens.includes("env")) {
    return "domainPattern must include the {env} token so environments don't collide on one domain";
  }
  return null;
}

/** Service keys removed from the schema — rejected with a migration hint before Zod runs. */
const DEPRECATED_SERVICE_KEYS: ReadonlyMap<string, string> = new Map([
  [
    "cluster",
    "`cluster` is not supported in launch-pad.toml — pass --cluster on deploy (e.g. launchpad deploy --cluster lower)",
  ],
  [
    "schedule",
    "`schedule` was removed — cluster auto-placement always bin-packs by free CPU/memory; drop `schedule` from launch-pad.toml",
  ],
  [
    "node",
    "`node` was removed — placement is automatic; the scheduler picks nodes (and provisions them when needed); drop `node` from launch-pad.toml",
  ],
  [
    "nodes",
    "`nodes` was removed — placement is automatic; the scheduler picks nodes (and provisions them when needed); drop `nodes` from launch-pad.toml",
  ],
  [
    "edge",
    "`edge` was removed — every web service is fronted by the cluster's dedicated edge node; drop `edge` from launch-pad.toml",
  ],
  [
    "topology",
    "`topology` was removed — the edge always runs on its own node, so every deploy is split-topology; drop `topology` from launch-pad.toml",
  ],
]);

const SUPPORTED_TOP_LEVEL_KEYS = new Set(["project", "component", "domainPattern", "service", "database", "job"]);

/** Keys allowed in a `[[database]]` block — rejects typos before Zod runs. */
const SUPPORTED_DATABASE_KEYS = new Set([
  "name",
  "engine",
  "version",
  "storage",
  "cpu",
  "memory",
  "databases",
  "backup",
]);

/** Keys allowed in a `[database.backup]` block. */
const SUPPORTED_BACKUP_KEYS = new Set(["schedule", "retentionDays"]);

const SUPPORTED_SERVICE_KEYS = new Set([
  "name",
  "cron",
  "dockerfile",
  "context",
  "replicas",
  "cpu",
  "memory",
  "env",
  "domain",
  "domainPattern",
  "port",
  "healthCheck",
  "rollout",
  "secrets",
  "volumes",
]);

/** Keys allowed in a `[[job]]` block — one-off containers run via `launchpad job run`. */
const SUPPORTED_JOB_KEYS = new Set([
  "name",
  "dockerfile",
  "context",
  "cpu",
  "memory",
  "env",
  "secrets",
]);

/**
 * Reject deprecated or unknown keys in a decoded TOML object before Zod runs, so
 * errors name the offending key and (for removed fields) point at the CLI flag.
 */
export function assertSupportedLaunchPadConfigRaw(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;

  const root = input as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!SUPPORTED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`(root).${key}: unsupported key "${key}"`);
    }
  }

  const databases = root.database;
  if (Array.isArray(databases)) {
    databases.forEach((raw, i) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      for (const key of Object.keys(raw)) {
        if (!SUPPORTED_DATABASE_KEYS.has(key)) {
          throw new Error(`database[${i}].${key}: unsupported key "${key}"`);
        }
      }
      const backup = (raw as Record<string, unknown>).backup;
      if (typeof backup === "object" && backup !== null && !Array.isArray(backup)) {
        for (const key of Object.keys(backup)) {
          if (!SUPPORTED_BACKUP_KEYS.has(key)) {
            throw new Error(`database[${i}].backup.${key}: unsupported key "${key}"`);
          }
        }
      }
    });
  }

  const services = root.service;
  if (Array.isArray(services)) {
    services.forEach((raw, i) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      for (const key of Object.keys(raw)) {
        const deprecated = DEPRECATED_SERVICE_KEYS.get(key);
        if (deprecated !== undefined) {
          throw new Error(`service[${i}].${key}: ${deprecated}`);
        }
        if (!SUPPORTED_SERVICE_KEYS.has(key)) {
          throw new Error(`service[${i}].${key}: unsupported key "${key}"`);
        }
      }
    });
  }

  const jobs = root.job;
  if (Array.isArray(jobs)) {
    jobs.forEach((raw, i) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
      for (const key of Object.keys(raw)) {
        if (!SUPPORTED_JOB_KEYS.has(key)) {
          throw new Error(`job[${i}].${key}: unsupported key "${key}"`);
        }
      }
    });
  }
}

/** @deprecated Removed — cluster placement always bin-packs by free CPU/memory. Kept so old config-baselines parse. */
export const ServiceScheduleSchema = z.enum(["even", "capacity"]);
/** @deprecated */
export type ServiceSchedule = z.infer<typeof ServiceScheduleSchema>;

/** @deprecated Removed — the edge always runs on its own node ("split"). Kept so old config-baselines parse. */
export const ServiceTopologySchema = z.enum(["split", "co-located", "auto"]);
/** @deprecated */
export type ServiceTopology = z.infer<typeof ServiceTopologySchema>;

export const VOLUME_PATH_HINT =
  "an absolute container path with no '..' segments, e.g. /data or /var/lib/app";

/** Returns a validation message, or null when the container mount path is well formed. */
export function volumePathError(path: string): string | null {
  if (!path.startsWith("/")) return `volume path must be absolute (start with /) — ${VOLUME_PATH_HINT}`;
  if (path === "/") return "volume path can't be the container root /";
  if (path.endsWith("/")) return "volume path must not end with a trailing /";
  if (path.split("/").includes("..")) return "volume path must not contain '..' segments";
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(path)) return `volume path has invalid characters — ${VOLUME_PATH_HINT}`;
  return null;
}

/**
 * One `[[service.volumes]]` entry: a named, persistent docker volume mounted into the
 * service's container(s) at `path`. The data lives on the node's disk and survives a
 * container replacement (a rolling deploy / restart), so SQLite, uploads, and local
 * caches don't reset on every deploy. See `docs/configuration.md`.
 */
export const VolumeDeclSchema = z
  .object({
    /** Volume name — unique within the service; used to derive the docker volume name. */
    name: label("volume name"),
    /** Absolute path inside the container where the volume is mounted. */
    path: z.string().superRefine((p, ctx) => {
      const err = volumePathError(p);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }),
  })
  .strict();
export type VolumeDecl = z.infer<typeof VolumeDeclSchema>;

/** Database engines a `[[database]]` block can run. Postgres only for now. */
export const DATABASE_ENGINES = ["postgres"] as const;
export const DatabaseEngineSchema = z.enum(DATABASE_ENGINES);
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>;

/** A Postgres image tag like "16" or "15.6". */
export const POSTGRES_VERSION_REGEX = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Unquoted SQL identifier for a logical database name (the directory each db's
 * backups land in). Looser than a DNS label — Postgres identifiers allow uppercase,
 * underscores, and `$` — but slash-free so it's a safe single S3 path segment.
 */
export const LOGICAL_DB_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const logicalDbName = z
  .string()
  .regex(
    LOGICAL_DB_NAME_REGEX,
    "logical database name must be a valid postgres identifier (letters, digits, underscore, $; start with a letter or underscore)",
  );

/**
 * `[database.backup]` — turns on the built-in S3 backup sidecar for a managed
 * database. The agent runs `pg_dump` per logical database on the `schedule` (a
 * 5-field UTC cron) and uploads a gzip dump to the cluster's backups bucket, then
 * prunes dumps older than `retentionDays` for that database. Operational, not
 * identity: schedule + retention may change after the first deploy.
 */
export const BackupDeclSchema = z
  .object({
    /** 5-field UTC cron expression for the daily/periodic backup run. */
    schedule: z.string(),
    /** Days of dumps retained per database; older ones are pruned after each run. */
    retentionDays: z
      .number()
      .int()
      .min(1, "retentionDays must be >= 1")
      .max(3650, "retentionDays must be <= 3650 (10 years)")
      .default(DEFAULT_BACKUP_RETENTION_DAYS),
  })
  .strict();
export type BackupDecl = z.infer<typeof BackupDeclSchema>;

/**
 * One `[[database]]` block: a managed, persisted database the CLI desugars into a
 * worker `[[service]]` (the engine image + a sticky data volume) plus an optional
 * S3 backup sidecar. There is NO user-facing build for it — the image is pinned by
 * `engine`/`version`. See `expandDatabaseServices` and `docs/configuration.md`.
 */
export const DatabaseDeclSchema = z
  .object({
    /** Becomes the service name (and container/ECR-free identity) — a DNS label. */
    name: label("database name"),
    engine: DatabaseEngineSchema.default("postgres"),
    version: z
      .string()
      .regex(POSTGRES_VERSION_REGEX, 'version must be a postgres image tag like "16" or "15.6"')
      .default(DEFAULT_POSTGRES_VERSION),
    /** Advisory storage hint (e.g. "20Gi") — sizes node-disk expectation; not a hard cap. */
    storage: z.string().min(1).optional(),
    cpu: z
      .number()
      .int()
      .min(SERVICE_NUMERIC_FIELD_MIN.cpu, "cpu must be a positive integer (vCPU shares, 1024 = 1 vCPU)")
      .default(DEFAULT_DATABASE_CPU),
    memory: z
      .number()
      .int()
      .min(SERVICE_NUMERIC_FIELD_MIN.memory, "memory must be a positive integer (MB)")
      .default(DEFAULT_DATABASE_MEMORY),
    /**
     * Logical databases to back up. Empty → the backup sidecar enumerates every
     * non-template database at run time. (LaunchPad does NOT create these — manage
     * them with migrations/psql; this only scopes which ones get dumped.)
     */
    databases: z.array(logicalDbName).default([]),
    backup: BackupDeclSchema.optional(),
  })
  .strict()
  .superRefine((db, ctx) => {
    if (db.backup !== undefined) {
      const exprErr = cronExpressionError(db.backup.schedule);
      if (exprErr) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: exprErr, path: ["backup", "schedule"] });
      } else if (nextCronFire(parseCronExpression(db.backup.schedule), Date.now()) === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "backup schedule never fires (no matching date within a year)",
          path: ["backup", "schedule"],
        });
      }
    }
  });
export type DatabaseDecl = z.infer<typeof DatabaseDeclSchema>;

/**
 * Marker attached to a desugared database service so the agent knows to run the
 * engine image (no build) and how to drive `pg_dump`. Carried on the wire in
 * desired.json; frozen identity in the config lock (a version bump is a migration).
 */
export const ServiceDatabaseSchema = z
  .object({
    engine: DatabaseEngineSchema,
    version: z.string().regex(POSTGRES_VERSION_REGEX),
    /** Logical databases to back up (empty → enumerate at run time). */
    databases: z.array(logicalDbName).default([]),
  })
  .strict();
export type ServiceDatabase = z.infer<typeof ServiceDatabaseSchema>;

/** One `[[job]]` block: a one-off worker image users run with `launchpad job run`. */
export const JobDeclSchema = z
  .object({
    name: label("job name"),
    dockerfile: z.string().default("./Dockerfile"),
    /** Docker build context, relative to the launch-pad.toml directory. */
    context: z.string().default("."),
    cpu: z
      .number()
      .int()
      .min(SERVICE_NUMERIC_FIELD_MIN.cpu, "cpu must be a positive integer (vCPU shares, 1024 = 1 vCPU)"),
    memory: z.number().int().min(SERVICE_NUMERIC_FIELD_MIN.memory, "memory must be a positive integer (MB)"),
    env: z.record(z.string(), z.string()).default({}),
    /** Secret key names — values live in SSM; maintained by `launchpad secret set`. */
    secrets: z
      .array(z.string().regex(SECRET_KEY_REGEX, `secret name must be ${SECRET_KEY_HINT}`))
      .default([]),
  })
  .strict();
export type JobDecl = z.infer<typeof JobDeclSchema>;

/** One `[[service]]` block in launch-pad.toml. */
export const ServiceDeclSchema = z
  .object({
    name: label("service name"),
    /**
     * 5-field cron expression (UTC) turning this worker into a scheduled job: the
     * agent runs one container per fire and lets it exit, instead of keeping a
     * long-running container. Workers only — see the superRefine constraints.
     */
    cron: z.string().optional(),
    dockerfile: z.string().default("./Dockerfile"),
    /** Docker build context, relative to the launch-pad.toml directory. */
    context: z.string().default("."),
    replicas: z.number().int().min(SERVICE_NUMERIC_FIELD_MIN.replicas, "replicas must be >= 1").default(1),
    cpu: z
      .number()
      .int()
      .min(SERVICE_NUMERIC_FIELD_MIN.cpu, "cpu must be a positive integer (vCPU shares, 1024 = 1 vCPU)"),
    memory: z.number().int().min(SERVICE_NUMERIC_FIELD_MIN.memory, "memory must be a positive integer (MB)"),
    env: z.record(z.string(), z.string()).default({}),
    /** Secret key names — values live in SSM; maintained by `launchpad secret set`. */
    secrets: z
      .array(z.string().regex(SECRET_KEY_REGEX, `secret name must be ${SECRET_KEY_HINT}`))
      .default([]),
    domain: z.string().min(1).optional(),
    /** Template for the domain under `--env <e>`; `{env}`/`{service}` are interpolated. */
    domainPattern: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthCheck: HealthCheckSchema.optional(),
    rollout: RolloutSchema.default({}),
    /** Persistent named volumes mounted into this service's container(s). */
    volumes: z.array(VolumeDeclSchema).default([]),
    /**
     * Managed-database marker. Set only by `expandDatabaseServices` (the desugar of
     * a `[[database]]` block) — not authorable directly in `[[service]]`, which is
     * why `database`/`backup` are absent from `SUPPORTED_SERVICE_KEYS`.
     */
    database: ServiceDatabaseSchema.optional(),
    /** S3 backup config for a managed database service (set by the desugar). */
    backup: BackupDeclSchema.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.database !== undefined) {
      const isWeb = s.domain !== undefined && s.port !== undefined;
      if (isWeb || s.cron !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a managed database service can't serve a domain or run on a cron",
          path: ["database"],
        });
      }
      if (s.volumes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a managed database service must declare a persistent volume",
          path: ["volumes"],
        });
      }
    }
    if (s.backup !== undefined && s.database === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`backup` is only valid on a managed database service",
        path: ["backup"],
      });
    }
    if ((s.domain === undefined) !== (s.port === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a web service needs BOTH `domain` and `port`; a worker needs NEITHER",
        path: ["domain"],
      });
    }
    const isWeb = s.domain !== undefined && s.port !== undefined;
    if (s.domainPattern !== undefined) {
      if (!isWeb) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`domainPattern` only applies to a web service (one with a `domain`)",
          path: ["domainPattern"],
        });
      } else {
        const err = domainPatternError(s.domainPattern);
        if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ["domainPattern"] });
      }
    }
    if (s.cron !== undefined) {
      const exprErr = cronExpressionError(s.cron);
      if (exprErr) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: exprErr, path: ["cron"] });
      } else if (nextCronFire(parseCronExpression(s.cron), Date.now()) === null) {
        // A parseable-but-impossible date (e.g. `0 0 30 2 *`, Feb 30) would make the
        // agent scan its full horizon every tick for nothing — reject it up front.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cron expression never fires (no matching date within a year)",
          path: ["cron"],
        });
      }
      if (isWeb) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`cron` only applies to a worker — a scheduled job can't also serve a domain; drop `domain`/`port`",
          path: ["cron"],
        });
      }
      if (s.healthCheck !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a `cron` service can't declare a healthCheck — a run is judged by its exit code, not a probe",
          path: ["healthCheck"],
        });
      }
      if (s.replicas > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a `cron` service runs exactly one container per fire — drop `replicas` (or set it to 1)",
          path: ["replicas"],
        });
      }
    }
    if (isWeb && s.healthCheck === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a web service needs a [service.healthCheck] so rolling updates are gated on readiness (zero-downtime) — both the surge probe and Caddy's load-balancer health check depend on it",
        path: ["healthCheck"],
      });
    }
    if (s.volumes.length > 0) {
      const vNames = new Set<string>();
      const vPaths = new Set<string>();
      s.volumes.forEach((v, vi) => {
        if (vNames.has(v.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate volume name "${v.name}"`,
            path: ["volumes", vi, "name"],
          });
        }
        vNames.add(v.name);
        if (vPaths.has(v.path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate volume path "${v.path}"`,
            path: ["volumes", vi, "path"],
          });
        }
        vPaths.add(v.path);
      });
    }
  });

/** The whole launch-pad.toml document. */
export const LaunchPadConfigSchema = z
  .object({
    project: label("project"),
    /**
     * This repo's deployable slice of the logical project (federated multi-repo
     * deploys). Optional — omitted means the TOML owns the whole project footprint
     * (today's behavior, owner = `project`). With a component the footprint owner
     * becomes `<project>--<component>` (see `componentOwner`).
     */
    component: label("component").optional(),
    /** Project-wide default `domainPattern` (per-service `domainPattern` overrides it). */
    domainPattern: z.string().min(1).optional(),
    service: z.array(ServiceDeclSchema).min(1, "at least one [[service]] is required"),
    /**
     * Managed databases — desugared into worker services + backup sidecars at deploy.
     * Optional (not defaulted) so existing `LaunchPadConfig` literals/call sites that
     * predate databases keep type-checking; new readers use `?? []`.
     */
    database: z.array(DatabaseDeclSchema).optional(),
    /**
     * One-off jobs are buildable worker images that normal deploy ignores. They are
     * run explicitly via `launchpad job run <name>`.
     */
    job: z.array(JobDeclSchema).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.domainPattern !== undefined) {
      const err = domainPatternError(cfg.domainPattern);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ["domainPattern"] });
    }
    // `--` is the project/component separator in derived footprint owners
    // (`componentOwner`); forbid it inside either label so an owner can never be
    // ambiguous between a literal project name and a project+component pair.
    if (cfg.project.includes(COMPONENT_SEPARATOR)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `project must not contain "${COMPONENT_SEPARATOR}" (reserved as the project/component separator)`,
        path: ["project"],
      });
    }
    if (cfg.component?.includes(COMPONENT_SEPARATOR)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `component must not contain "${COMPONENT_SEPARATOR}" (reserved as the project/component separator)`,
        path: ["component"],
      });
    }
    const seen = new Set<string>();
    cfg.service.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate service name "${s.name}"`,
          path: ["service", i, "name"],
        });
      }
      seen.add(s.name);
    });
    // A `[[database]]` desugars into a service named after it, so its name shares the
    // service namespace — reject collisions and duplicate database names up front.
    (cfg.database ?? []).forEach((db, i) => {
      if (seen.has(db.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `database name "${db.name}" collides with an existing service or database name`,
          path: ["database", i, "name"],
        });
      }
      seen.add(db.name);
    });
    (cfg.job ?? []).forEach((job, i) => {
      if (seen.has(job.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `job name "${job.name}" collides with an existing service, database, or job name`,
          path: ["job", i, "name"],
        });
      }
      seen.add(job.name);
    });
  });

export type ServiceDecl = z.infer<typeof ServiceDeclSchema>;
export type LaunchPadConfig = z.infer<typeof LaunchPadConfigSchema>;

/** Parse + validate a decoded TOML object. Throws on invalid or unsupported input. */
export function parseLaunchPadConfig(input: unknown): LaunchPadConfig {
  assertSupportedLaunchPadConfigRaw(input);
  return LaunchPadConfigSchema.parse(input);
}

/** True when the service declares ingress (web) rather than being a worker. */
export function isWebService(s: ServiceDecl): boolean {
  return s.domain !== undefined && s.port !== undefined;
}

/** Pinned engine image for a managed database — pulled, never built. */
export function databaseImage(db: { engine: DatabaseEngine; version: string }): string {
  // Only postgres today; keep the switch so a new engine is a compile error to forget.
  switch (db.engine) {
    case "postgres":
      return `${POSTGRES_IMAGE_REPO}:${db.version}`;
  }
}

/** True when a desugared service is a managed database (runs a pinned engine image, not a build). */
export function isDatabaseService(s: Pick<ServiceDecl, "database">): boolean {
  return s.database !== undefined;
}

/**
 * Desugar every `[[database]]` block into an appended worker `[[service]]` (engine
 * image + sticky data volume + POSTGRES_PASSWORD secret + database/backup markers),
 * returning a config whose `database` array is cleared. The single point where the
 * managed-database concept becomes ordinary services — everything downstream
 * (placement, capacity, merge, config-lock, the agent) sees only services.
 */
export function expandDatabaseServices(config: LaunchPadConfig): LaunchPadConfig {
  const databases = config.database ?? [];
  if (databases.length === 0) return config;
  const dbServices = databases.map((db) =>
    ServiceDeclSchema.parse({
      name: db.name,
      cpu: db.cpu,
      memory: db.memory,
      secrets: [POSTGRES_PASSWORD_SECRET],
      volumes: [{ name: POSTGRES_VOLUME_NAME, path: POSTGRES_DATA_PATH }],
      database: { engine: db.engine, version: db.version, databases: db.databases },
      ...(db.backup !== undefined ? { backup: db.backup } : {}),
    }),
  );
  return { ...config, service: [...config.service, ...dbServices], database: [] };
}

/** All managed-database service names in a parsed (pre-expansion) config. */
export function databaseServiceNames(config: LaunchPadConfig): string[] {
  return (config.database ?? []).map((db) => db.name);
}

/**
 * The footprint owner for a deploy environment. With no env it's the base project
 * (today's behavior); with an env it's `<project>-<env>`, so an environment's
 * services get their own replace key, container names, and capacity accounting and
 * coexist with prod on the same node.
 */
export function envProject(project: string, env: string | undefined): string {
  return env === undefined ? project : `${project}-${env}`;
}

/**
 * The base footprint owner for a project + optional component. Without a
 * component it's the project itself (zero change for single-TOML projects);
 * with one it's `<project>--<component>`, giving each component repo its own
 * replace key, config-lock baseline, secrets tree, and S3 state prefix while
 * sibling components coexist untouched on the same nodes.
 */
export function componentOwner(project: string, component: string | undefined): string {
  return component === undefined ? project : `${project}${COMPONENT_SEPARATOR}${component}`;
}

/**
 * The footprint owner a deploy (or any footprint-scoped command) operates on:
 * `envProject(componentOwner(project, component), env)`. The single derivation
 * point for owner strings — derive here, never parse an owner back apart.
 */
export function footprintOwner(
  config: { project: string; component?: string | undefined },
  env: string | undefined,
): string {
  return envProject(componentOwner(config.project, config.component), env);
}

/**
 * Merge a service's declared `env` with the deploy `--env` name. Production
 * deploys pass through `declared` unchanged; named environments inject
 * `LAUNCH_PAD_ENVIRONMENT` unless the service already sets that key.
 */
export function containerEnvForDeploy(
  declared: Record<string, string>,
  deployEnv: string | undefined,
): Record<string, string> {
  if (deployEnv === undefined) return declared;
  return { [LAUNCH_PAD_ENVIRONMENT]: deployEnv, ...declared };
}

export interface ServiceDomainInput {
  /** The service's literal (production) domain, or undefined for a worker. */
  domain?: string | undefined;
  /** Effective pattern (service-level, else the project default), if any. */
  domainPattern?: string | undefined;
  /** Service name, for the `{service}` token. */
  service: string;
}

/**
 * Project a service's domain for a deploy environment:
 * - worker (no `domain`) → undefined (no ingress, regardless of env)
 * - no env (base/prod) → the literal `domain`
 * - env + `domainPattern` → the pattern with `{env}`/`{service}` filled in
 * - env + no pattern → the default convention: insert `-<env>` after the first DNS label
 */
export function resolveServiceDomain(input: ServiceDomainInput, env: string | undefined): string | undefined {
  if (input.domain === undefined) return undefined;
  if (env === undefined) return input.domain;
  if (input.domainPattern) {
    return input.domainPattern.replace(/\{(env|service)\}/g, (_, k: string) => (k === "env" ? env : input.service));
  }
  return input.domain.replace(/^([^.]+)/, `$1-${env}`);
}
