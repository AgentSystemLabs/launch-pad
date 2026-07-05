import { z } from "zod";
import { PREVIEW_MARKER_VERSION } from "./constants";
import { componentOwner, envProject, HOSTNAME_REGEX, LABEL_REGEX } from "./config";

/**
 * Strict field shapes: the marker is read back from S3 and drives DESTRUCTIVE actions
 * (an undeploy, a `projects/<owner>/` prefix sweep), so anything a tampered document
 * could smuggle into those paths is rejected at parse time — defense-in-depth on top
 * of the CLI's own runtime guards.
 */
const OWNER_REGEX = /^[a-z0-9][a-z0-9-]*$/;
// HOSTNAME_REGEX (from config.ts) is intentionally stricter than the local regex it replaced:
// labels must end with [a-z0-9], so hostnames like "foo-.example.com" are now rejected. Any
// pre-existing S3 marker with a hyphen-terminated label is RFC-violating and can be re-written
// by re-deploying the environment.

/**
 * Preview-environment marker: one `projects/<project>-<env>/preview.json` per env
 * footprint, written by `deploy --env` and read only by the `preview` CLI commands.
 * It is the registry that makes previews enumerable (`preview list`), destroyable
 * (`preview destroy`), and TTL-prunable (`preview prune`). Advisory CLI-side state:
 * the agent never reads it, so the schema is versioned separately from the wire
 * protocol. DNS is user-managed (a wildcard at the edge covers every env), so the
 * marker records domains for display only — markers written before the Route53
 * integration was removed may still carry a `dns` array; it parses but is ignored.
 */

const PreviewMarkerObjectSchema = z
  .object({
    version: z.literal(PREVIEW_MARKER_VERSION),
    /** The base project (from launch-pad.toml). */
    project: z.string().regex(LABEL_REGEX),
    /** The component (from launch-pad.toml), when the footprint is component-scoped. */
    component: z.string().regex(LABEL_REGEX).optional(),
    /** The environment label (`deploy --env <env>`). */
    env: z.string().regex(LABEL_REGEX),
    /** The footprint owner — always `envProject(componentOwner(project, component), env)`. */
    owner: z.string().regex(OWNER_REGEX),
    /** ISO timestamp of the env's FIRST deploy (preserved across re-deploys). */
    createdAt: z.string().min(1),
    /** ISO timestamp of the latest deploy that touched this env. */
    updatedAt: z.string().min(1),
    /** ISO expiry deadline from `--ttl`, or null for a preview with no TTL. */
    expiresAt: z.string().nullable(),
    /** Every env-projected web domain (config-wide, not just this deploy's subset). */
    domains: z.array(z.string().regex(HOSTNAME_REGEX)).default([]),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.owner !== envProject(componentOwner(m.project, m.component), m.env)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `owner "${m.owner}" does not match project "${m.project}"${m.component !== undefined ? ` + component "${m.component}"` : ""} + env "${m.env}"`,
        path: ["owner"],
      });
    }
  });

/**
 * Strip the legacy `dns` array (Route53 bookkeeping from before DNS automation was
 * removed) before the strict parse, so pre-existing markers keep parsing.
 */
export const PreviewMarkerSchema = z.preprocess((value) => {
  if (value !== null && typeof value === "object" && "dns" in value) {
    const { dns: _legacy, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}, PreviewMarkerObjectSchema);

export type PreviewMarker = z.infer<typeof PreviewMarkerSchema>;

export function parsePreviewMarker(input: unknown): PreviewMarker {
  return PreviewMarkerSchema.parse(input);
}

/** Inclusive TTL bounds: a preview lives at least a minute and at most 90 days. */
const TTL_MIN_MS = 60_000;
const TTL_MAX_MS = 90 * 86_400_000;
const TTL_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Human hint for an invalid `--ttl`; kept next to the parser so the two can't drift. */
export const PREVIEW_TTL_HINT = "pass <n>m, <n>h, or <n>d between 1m and 90d, e.g. --ttl 72h";

/**
 * Parse a preview TTL like `30m`, `72h`, or `7d` to milliseconds. Returns null on
 * anything malformed or outside [1m, 90d] — the caller owns the error message
 * (`PREVIEW_TTL_HINT`).
 */
export function parsePreviewTtlMs(raw: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(raw);
  if (!match) return null;
  const n = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const ms = n * (TTL_UNIT_MS[match[2] as string] as number);
  if (!Number.isSafeInteger(ms) || ms < TTL_MIN_MS || ms > TTL_MAX_MS) return null;
  return ms;
}

export interface BuildPreviewMarkerInput {
  project: string;
  /** Component when the deploying TOML is component-scoped (federated multi-repo). */
  component?: string | undefined;
  env: string;
  /** ISO timestamp of this deploy. */
  now: string;
  /** TTL for this deploy, or null when `--ttl` wasn't passed. */
  ttlMs: number | null;
  /** Env-projected web domains (config-wide). */
  domains: string[];
  /** The existing marker on a re-deploy, so createdAt / expiry survive. */
  prior?: PreviewMarker | null;
}

/**
 * Build (or refresh) a preview marker. A re-deploy keeps the original `createdAt` and
 * re-arms the expiry only when this deploy passed a TTL (otherwise the prior deadline
 * stands).
 */
export function buildPreviewMarker(input: BuildPreviewMarkerInput): PreviewMarker {
  const prior = input.prior ?? null;
  const expiresAt =
    input.ttlMs !== null
      ? new Date(Date.parse(input.now) + input.ttlMs).toISOString()
      : (prior?.expiresAt ?? null);

  return {
    version: PREVIEW_MARKER_VERSION,
    project: input.project,
    // Emitted only when set so non-component markers stay byte-identical to before.
    ...(input.component !== undefined ? { component: input.component } : {}),
    env: input.env,
    owner: envProject(componentOwner(input.project, input.component), input.env),
    createdAt: prior?.createdAt ?? input.now,
    updatedAt: input.now,
    expiresAt,
    domains: [...new Set(input.domains)].sort(),
  };
}

/**
 * Whether a marker is past its TTL. A marker without a TTL never expires; an
 * unparsable deadline counts as expired (fail-closed — prune exists to reap leaks).
 */
export function isPreviewExpired(marker: PreviewMarker, nowMs: number): boolean {
  if (marker.expiresAt === null) return false;
  const deadline = Date.parse(marker.expiresAt);
  if (Number.isNaN(deadline)) return true;
  return nowMs > deadline;
}

export interface PreviewPrunePlan {
  expired: PreviewMarker[];
  kept: PreviewMarker[];
}

/** Split markers into expired (to destroy) and kept, preserving input order within each. */
export function planPreviewPrune(markers: PreviewMarker[], nowMs: number): PreviewPrunePlan {
  const expired: PreviewMarker[] = [];
  const kept: PreviewMarker[] = [];
  for (const m of markers) (isPreviewExpired(m, nowMs) ? expired : kept).push(m);
  return { expired, kept };
}

/**
 * Markers matching an env, optionally narrowed to one base project and one
 * component. `component` is matched only when `project` is given (a component
 * name alone is meaningless); `undefined` for either means "don't filter on it"
 * — note that means a project-only filter matches ALL of that project's
 * components, so callers disambiguating a destroy must pass the component.
 */
export function selectPreviewMarkers(
  markers: PreviewMarker[],
  env: string,
  project: string | undefined,
  component?: string | undefined,
): PreviewMarker[] {
  return markers.filter(
    (m) =>
      m.env === env &&
      (project === undefined || m.project === project) &&
      (project === undefined || component === undefined || m.component === component),
  );
}
