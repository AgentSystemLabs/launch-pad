/** Shared page plumbing: the launch-time context, LpOpts derivation, and the
 * full-document response helper every page handler uses. */
import type { Context } from "hono";
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { loadConfig } from "./app-config";
import type { LpOpts } from "./cli-driver";
import { Layout, type NavKey } from "./components/layout";

/** Launch-time overrides from `launchpad dashboard --cluster/--profile/--region`. */
export interface DashboardCtx {
  cluster?: string;
  profile?: string;
  region?: string;
}

/** The cluster shown in the header nav and used by cluster-less pages. */
export function navCluster(dctx: DashboardCtx): string {
  return dctx.cluster || loadConfig().defaultCluster || "default";
}

/** Build the CLI opts for a read, merging launch-time overrides + saved defaults. */
export function lpOpts(dctx: DashboardCtx, cluster?: string): LpOpts {
  const cfg = loadConfig();
  return {
    cluster: cluster || dctx.cluster || cfg.defaultCluster || undefined,
    profile: dctx.profile || cfg.profile || undefined,
    region: dctx.region || cfg.region || undefined,
  };
}

/** Render a full HTML document response around the shared layout. */
export function pageResponse(
  c: Context,
  meta: { title: string; cluster: string; active: NavKey },
  children: Child,
): Response | Promise<Response> {
  return c.html(
    html`<!doctype html>${(
      <Layout title={meta.title} cluster={meta.cluster} active={meta.active}>
        {children}
      </Layout>
    )}`,
  );
}

/** Render a JSX fragment to an HTML string (SSE frames). */
export function renderFragment(node: unknown): string {
  return String(node);
}

const PARAM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a route param before it reaches a spawned CLI argv or a room key.
 * A leading `-` would be parsed as a flag by the subprocess, and `:`/`/` would
 * collide the `cluster:node`-style room keys. Returns null on anything odd —
 * handlers 404 instead.
 */
export function safeParam(value: string | undefined): string | null {
  return value && PARAM_RE.test(value) ? value : null;
}
