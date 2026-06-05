import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { DEFAULT_CLUSTER } from "@agentsystemlabs/launch-pad-shared";
import { z } from "zod";
import { CliError } from "../errors";

/**
 * Per-cluster AWS target. This is the ONLY place AWS accounts / credentials live
 * — S3 stays the authoritative node registry. `roleArn` (cross-account
 * assume-role) is reserved for Phase 2 and not yet honored by prepareAws.
 */
const ClusterTargetSchema = z
  .object({
    region: z.string().min(1).optional(),
    profile: z.string().min(1).optional(),
    roleArn: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    sessionName: z.string().min(1).optional(),
  })
  .strict();

export type ClusterTarget = z.infer<typeof ClusterTargetSchema>;

const LocalConfigSchema = z
  .object({
    /** Cluster used when `--cluster` is omitted. */
    defaultCluster: z.string().min(1).optional(),
    clusters: z.record(z.string(), ClusterTargetSchema).default({}),
  })
  .strict();

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

/** `~/.launch-pad/config.toml` (overridable via LAUNCHPAD_HOME for tests). */
export function localConfigPath(): string {
  const home = process.env.LAUNCHPAD_HOME ?? homedir();
  return join(home, ".launch-pad", "config.toml");
}

/** Load local prefs, or an empty config when the file doesn't exist. */
export function loadLocalConfig(): LocalConfig {
  const path = localConfigPath();
  if (!existsSync(path)) return { clusters: {} };
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`failed to parse ${path}\n  ${(error as Error).message}`);
  }
  try {
    return LocalConfigSchema.parse(raw);
  } catch (error) {
    throw new CliError(`invalid ${path}\n  ${(error as Error).message}`);
  }
}

/** The AWS target for a cluster, or undefined if it isn't configured locally. */
export function resolveClusterTarget(clusterId: string): ClusterTarget | undefined {
  return loadLocalConfig().clusters[clusterId];
}

function writeLocalConfig(config: LocalConfig): void {
  const path = localConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(config), "utf8");
}

/**
 * Create/merge a cluster's local target. By default the first cluster also becomes
 * the local `defaultCluster` (explicit `cluster create`); pass
 * `{ setDefaultIfFirst: false }` to record a target WITHOUT hijacking the default
 * (implicit tracking from `deploy`/`node create --cluster X`).
 */
export function upsertClusterTarget(
  clusterId: string,
  target: ClusterTarget,
  options: { setDefaultIfFirst?: boolean } = {},
): LocalConfig {
  const { setDefaultIfFirst = true } = options;
  const config = loadLocalConfig();
  config.clusters[clusterId] = { ...config.clusters[clusterId], ...target };
  if (setDefaultIfFirst && !config.defaultCluster && Object.keys(config.clusters).length === 1) {
    config.defaultCluster = clusterId;
  }
  writeLocalConfig(config);
  return config;
}

/**
 * Record a cluster's AWS target locally so the `cluster` commands can reach a
 * cluster that was created implicitly by `deploy`/`node create --cluster X` (which
 * write the authoritative state to S3 but, historically, left nothing locally — so
 * `cluster list`/`show`/`pause`/… couldn't see it). No-op for the implicit `default`
 * cluster or a target that's already known, and it never changes the default cluster.
 */
export function rememberClusterTarget(
  clusterId: string,
  target: { region?: string; profile?: string },
): void {
  if (clusterId === DEFAULT_CLUSTER) return;
  if (resolveClusterTarget(clusterId)) return;
  const clean: ClusterTarget = {};
  if (target.region) clean.region = target.region;
  if (target.profile) clean.profile = target.profile;
  upsertClusterTarget(clusterId, clean, { setDefaultIfFirst: false });
}

/** Set the cluster used when `--cluster` is omitted. */
export function setDefaultCluster(clusterId: string): void {
  const config = loadLocalConfig();
  config.defaultCluster = clusterId;
  writeLocalConfig(config);
}

/**
 * Clear the persistent default, reverting to the implicit `default` cluster
 * (ambient creds + legacy un-prefixed S3 keys). No-op when none is set.
 */
export function clearDefaultCluster(): void {
  const config = loadLocalConfig();
  if (config.defaultCluster === undefined) return;
  delete config.defaultCluster;
  writeLocalConfig(config);
}

/** The cluster a command targets, resolved from this invocation's flags + local prefs. */
export interface EffectiveCluster {
  /** The cluster id that will be used: `--cluster` → `defaultCluster` → "default". */
  cluster: string;
  /** What an omitted `--cluster` resolves to: `defaultCluster` ?? "default". */
  persistedDefault: string;
  /** True when the effective cluster is the implicit `default`. */
  isImplicitDefault: boolean;
  /** True when `--cluster` on this invocation differs from the persistent default. */
  overridden: boolean;
  /** Region known locally (`--region` wins, else the cluster's saved target). */
  region?: string;
  /** Profile known locally (`--profile` wins, else the cluster's saved target). */
  profile?: string;
  /** Cross-account role for the cluster, when configured (Phase 2). */
  roleArn?: string;
}

/**
 * Resolve which cluster a command targets — the single source of truth for the
 * `--cluster` → `defaultCluster` → "default" precedence (mirrors `prepareAws`),
 * plus the local region/profile/roleArn it would inherit. Pure: pass `local` to
 * test without touching the filesystem.
 */
export function effectiveCluster(
  opts: { cluster?: string; region?: string; profile?: string },
  local: LocalConfig = loadLocalConfig(),
): EffectiveCluster {
  const persistedDefault = local.defaultCluster ?? DEFAULT_CLUSTER;
  const cluster = opts.cluster ?? persistedDefault;
  const target = local.clusters[cluster];
  return {
    cluster,
    persistedDefault,
    isImplicitDefault: cluster === DEFAULT_CLUSTER,
    overridden: opts.cluster !== undefined && opts.cluster !== persistedDefault,
    region: opts.region ?? target?.region,
    profile: opts.profile ?? target?.profile,
    roleArn: target?.roleArn,
  };
}

/** Drop a cluster's local target (e.g. after `cluster destroy`). No-op if absent. */
export function removeClusterTarget(clusterId: string): void {
  const config = loadLocalConfig();
  if (!(clusterId in config.clusters)) return;
  delete config.clusters[clusterId];
  if (config.defaultCluster === clusterId) delete config.defaultCluster;
  writeLocalConfig(config);
}
