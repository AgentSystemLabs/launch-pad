/** The port Caddy's admin API listens on (Caddy's own default). */
const CADDY_ADMIN_PORT = 2019;
const ADMIN_LISTEN = `127.0.0.1:${CADDY_ADMIN_PORT}`;
const ADMIN = process.env.LAUNCHPAD_CADDY_ADMIN ?? `http://${ADMIN_LISTEN}`;

// Caddy guards its admin API against DNS-rebinding by checking the request origin.
// Our agent calls it over loopback (not exposed externally), so we allow the
// loopback hosts plus the empty origin that a server-side fetch sends. This admin
// block is included in every /load so it persists across config reloads.
const ADMIN_BLOCK = {
  listen: ADMIN_LISTEN,
  origins: ["", ADMIN_LISTEN, `localhost:${CADDY_ADMIN_PORT}`, `[::1]:${CADDY_ADMIN_PORT}`],
};

/**
 * Load-balancing + health-check tuning that keeps rollouts zero-downtime. These
 * are grouped here so the rollout-safety knobs are discoverable in one place
 * rather than scattered as literals inside the handler.
 */
const LB_TUNING = {
  /** Transparently retry a request that hits a draining/dead replica. */
  retries: 3,
  tryDuration: "5s",
  tryInterval: "250ms",
  /** Passive check: evict an upstream that refuses a connection or returns 5xx. */
  passiveFailDuration: "10s",
  passiveMaxFails: 1,
  /** Active check cadence for web replicas that declare a health path. */
  activeInterval: "5s",
  activeTimeout: "2s",
  /** Caddy reads a single-digit expect_status as a status *class*; 2 = any 2xx. */
  activeExpectStatusClass: 2,
} as const;

/** Cap on Caddy error-body text echoed into status (avoid unbounded status writes). */
const CADDY_ERROR_TEXT_MAX = 200;

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
//
// ⚠️ CAVEAT: this caches what the agent last SENT, not what Caddy currently holds.
// If Caddy restarts (crash/OOM/manual reload) without the agent restarting, it
// reverts to an empty config but `lastConfigJson` still matches, so the agent
// won't re-push and HTTPS routing stays broken until the agent restarts. Restart
// the agent (or clear this cache) if you ever bounce Caddy out from under it.
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
      retries: LB_TUNING.retries,
      try_duration: LB_TUNING.tryDuration,
      try_interval: LB_TUNING.tryInterval,
    },
    health_checks: {
      // Passive: a request that fails (refused connection or 5xx) immediately
      // evicts that upstream for fail_duration, so subsequent requests skip it —
      // covers the window before the active check or the next shard poll catches up.
      passive: {
        fail_duration: LB_TUNING.passiveFailDuration,
        max_fails: LB_TUNING.passiveMaxFails,
        unhealthy_status: [500, 502, 503, 504],
      },
      ...(route.healthPath
        ? {
            active: {
              uri: route.healthPath,
              interval: LB_TUNING.activeInterval,
              timeout: LB_TUNING.activeTimeout,
              expect_status: LB_TUNING.activeExpectStatusClass,
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
      return {
        managed,
        lastReloadAt,
        error: `caddy /load ${res.status}: ${text.slice(0, CADDY_ERROR_TEXT_MAX)}`,
      };
    }
    lastConfigJson = json;
    lastReloadAt = new Date().toISOString();
    return { managed, lastReloadAt, error: null };
  } catch (error) {
    return { managed, lastReloadAt, error: (error as Error).message };
  }
}
