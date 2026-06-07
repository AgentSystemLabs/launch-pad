const ADMIN = process.env.LAUNCHPAD_CADDY_ADMIN ?? "http://127.0.0.1:2019";

// Caddy guards its admin API against DNS-rebinding by checking the request origin.
// Our agent calls it over loopback (not exposed externally), so we allow the
// loopback hosts plus the empty origin that a server-side fetch sends. This admin
// block is included in every /load so it persists across config reloads.
const ADMIN_BLOCK = {
  listen: "127.0.0.1:2019",
  origins: ["", "127.0.0.1:2019", "localhost:2019", "[::1]:2019"],
};

export interface WebRoute {
  domain: string;
  /** Reverse-proxy upstream dials, e.g. "127.0.0.1:20001" or "10.0.1.5:20001". */
  upstreams: string[];
  /** Active-health-check path (web replicas only). */
  healthPath?: string | undefined;
}

export interface CaddyOutcome {
  managed: boolean;
  lastReloadAt: string | null;
  error: string | null;
}

// In-memory guard so we don't reload Caddy every tick when nothing changed.
let lastConfigJson = "";
let lastReloadAt: string | null = null;

/**
 * A Caddy server listening on :443 with host-matched reverse-proxy routes.
 * Caddy's automatic HTTPS provisions a certificate for each matched host and
 * stands up the :80 ACME/redirect server on its own.
 */
function reverseProxyHandler(route: WebRoute): unknown {
  return {
    handler: "reverse_proxy",
    upstreams: route.upstreams.map((dial) => ({ dial })),
    load_balancing: {
      selection_policy: { policy: "round_robin" },
      // Zero-downtime on rollout: when a request hits a draining/dead replica
      // (e.g. an old replica that already called server.close() while the edge's
      // shard poll still lists it), transparently retry it on another upstream
      // instead of returning an error to the client.
      retries: 3,
      try_duration: "5s",
      try_interval: "250ms",
    },
    health_checks: {
      // Passive: a request that fails (refused connection or 5xx) immediately
      // evicts that upstream for fail_duration, so subsequent requests skip it —
      // covers the window before the active check or the next shard poll catches up.
      passive: {
        fail_duration: "10s",
        max_fails: 1,
        unhealthy_status: [500, 502, 503, 504],
      },
      ...(route.healthPath
        ? {
            active: {
              uri: route.healthPath,
              interval: "5s",
              timeout: "2s",
              expect_status: 2,
            },
          }
        : {}),
    },
  };
}

export function buildConfig(routes: WebRoute[]): unknown {
  const live = routes.filter((r) => r.upstreams.length > 0);
  if (live.length === 0) {
    return { admin: ADMIN_BLOCK, apps: { http: { servers: {} } } };
  }
  return {
    admin: ADMIN_BLOCK,
    apps: {
      http: {
        servers: {
          launchpad: {
            listen: [":443"],
            routes: live.map((r) => ({
              match: [{ host: [r.domain] }],
              handle: [reverseProxyHandler(r)],
            })),
          },
        },
      },
    },
  };
}

/** Push the desired routing config to Caddy's admin API (idempotent). */
export async function applyCaddy(routes: WebRoute[]): Promise<CaddyOutcome> {
  const managed = routes.length > 0;
  const json = JSON.stringify(buildConfig(routes));

  if (json === lastConfigJson) {
    return { managed, lastReloadAt, error: null };
  }

  try {
    const res = await fetch(`${ADMIN}/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { managed, lastReloadAt, error: `caddy /load ${res.status}: ${text.slice(0, 200)}` };
    }
    lastConfigJson = json;
    lastReloadAt = new Date().toISOString();
    return { managed, lastReloadAt, error: null };
  } catch (error) {
    return { managed, lastReloadAt, error: error instanceof Error ? error.message : String(error) };
  }
}
