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
  hostPort: number;
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
export function buildConfig(routes: WebRoute[]): unknown {
  if (routes.length === 0) {
    return { admin: ADMIN_BLOCK, apps: { http: { servers: {} } } };
  }
  return {
    admin: ADMIN_BLOCK,
    apps: {
      http: {
        servers: {
          launchpad: {
            listen: [":443"],
            routes: routes.map((r) => ({
              match: [{ host: [r.domain] }],
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: `127.0.0.1:${r.hostPort}` }],
                },
              ],
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
    return { managed, lastReloadAt, error: (error as Error).message };
  }
}
