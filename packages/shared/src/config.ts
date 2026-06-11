import { z } from "zod";
import { LAUNCH_PAD_ENVIRONMENT } from "./constants";
import { HealthCheckSchema, RolloutSchema } from "./health";
import { SECRET_KEY_HINT, SECRET_KEY_REGEX } from "./secrets";

/** DNS/label-safe identifier: lowercase alphanumeric + hyphen, 1–40 chars. */
export const LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

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

const nodeId = (what: string) =>
  z.string().regex(NODE_ID_REGEX, `${what} must be ${NODE_ID_HINT}`);

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
    "`cluster` is not supported in launch-pad.toml — pass --cluster on deploy (e.g. launch-pad deploy --cluster lower)",
  ],
]);

const SUPPORTED_TOP_LEVEL_KEYS = new Set(["project", "domainPattern", "service"]);

const SUPPORTED_SERVICE_KEYS = new Set([
  "name",
  "node",
  "nodes",
  "edge",
  "schedule",
  "topology",
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

  const services = root.service;
  if (!Array.isArray(services)) return;

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

/** Node-picking strategy for cluster auto-placement (services without `node`/`nodes`). */
export const ServiceScheduleSchema = z.enum(["even", "capacity"]);
export type ServiceSchedule = z.infer<typeof ServiceScheduleSchema>;

/** Ingress shape for cluster auto-placement (services without `node`/`nodes`). */
export const ServiceTopologySchema = z.enum(["split", "co-located", "auto"]);
export type ServiceTopology = z.infer<typeof ServiceTopologySchema>;

/** One `[[service]]` block in launch-pad.toml. */
export const ServiceDeclSchema = z
  .object({
    name: label("service name"),
    /** Single target node (mutually exclusive with `nodes`). Omit both to place via `deploy --cluster`. */
    node: nodeId("node").optional(),
    /** Multiple target nodes — replicas are distributed round-robin across them. */
    nodes: z.array(nodeId("node")).min(1).optional(),
    /** Node id whose Caddy fronts this service's domain (a dedicated edge). */
    edge: nodeId("edge").optional(),
    /**
     * Cluster auto-placement strategy: "even" round-robin (default) or "capacity"
     * bin-packing by free CPU/memory. Optional here (NOT `.default()`) so the
     * superRefine below can reject an EXPLICIT value alongside `node`/`nodes`;
     * the trailing `.transform()` fills the default afterwards.
     */
    schedule: ServiceScheduleSchema.optional(),
    /**
     * Cluster auto-placement ingress shape: "split" (private app nodes fronted by
     * an edge), "co-located" (one both-role node, local Caddy, no remote edge), or
     * "auto" (default: edge when resolvable). Optional for the same reason as
     * `schedule`.
     */
    topology: ServiceTopologySchema.optional(),
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
    /** Secret key names — values live in SSM; maintained by `launch-pad secret set`. */
    secrets: z
      .array(z.string().regex(SECRET_KEY_REGEX, `secret name must be ${SECRET_KEY_HINT}`))
      .default([]),
    domain: z.string().min(1).optional(),
    /** Template for the domain under `--env <e>`; `{env}`/`{service}` are interpolated. */
    domainPattern: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthCheck: HealthCheckSchema.optional(),
    rollout: RolloutSchema.default({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.node !== undefined && s.nodes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "set `node` or `nodes`, not both — omit both to place via `deploy --cluster`",
        path: ["node"],
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
    if (s.edge !== undefined && !isWeb) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "only web services (with a domain) can be routed by an `edge`",
        path: ["edge"],
      });
    }
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
    const isPinned = s.node !== undefined || s.nodes !== undefined;
    if (s.schedule !== undefined && isPinned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`schedule` only applies to cluster auto-placement — drop it, or remove `node`/`nodes`",
        path: ["schedule"],
      });
    }
    if (s.topology !== undefined && isPinned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`topology` only applies to cluster auto-placement — drop it, or remove `node`/`nodes`",
        path: ["topology"],
      });
    }
    if (s.topology === "split" && !isWeb) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '`topology = "split"` only applies to a web service — a worker has no ingress to split',
        path: ["topology"],
      });
    }
    if (s.topology === "co-located" && s.edge !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '`topology = "co-located"` serves the domain from the service\'s own node — remove `edge`, or use `topology = "split"`',
        path: ["edge"],
      });
    }
    const nodeCount = s.nodes?.length ?? (s.node ? 1 : 0);
    if (isWeb && nodeCount > 1 && s.edge === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a web service spread across multiple `nodes` needs a dedicated `edge` to load-balance them",
        path: ["edge"],
      });
    }
    if (isWeb && s.healthCheck === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a web service needs a [service.healthCheck] so rolling updates are gated on readiness (zero-downtime) — both the surge probe and Caddy's load-balancer health check depend on it",
        path: ["healthCheck"],
      });
    }
  })
  .transform((s) => ({
    ...s,
    schedule: s.schedule ?? ("even" as ServiceSchedule),
    topology: s.topology ?? ("auto" as ServiceTopology),
  }));

/** The whole launch-pad.toml document. */
export const LaunchPadConfigSchema = z
  .object({
    project: label("project"),
    /** Project-wide default `domainPattern` (per-service `domainPattern` overrides it). */
    domainPattern: z.string().min(1).optional(),
    service: z.array(ServiceDeclSchema).min(1, "at least one [[service]] is required"),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.domainPattern !== undefined) {
      const err = domainPatternError(cfg.domainPattern);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: ["domainPattern"] });
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

/** The node ids a service targets explicitly (`nodes` or the single `node`). */
export function targetNodes(s: ServiceDecl): string[] {
  return s.nodes ?? (s.node ? [s.node] : []);
}

/** True when placement is deferred to `deploy --cluster` (no `node` / `nodes` in TOML). */
export function usesClusterPlacement(s: ServiceDecl): boolean {
  return targetNodes(s).length === 0;
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
