/**
 * Optional token auth for the dashboard. Localhost binds need no auth; binding a
 * non-loopback interface requires LAUNCH_PAD_DASHBOARD_TOKEN (enforced at startup
 * by the command). When a token is configured, every route (except /healthz) needs
 * it via cookie, `Authorization: Bearer`, or a one-time `?token=` (which sets the
 * cookie and redirects so the token never lingers in the URL).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "lp_dashboard_token";
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 60_000;

/** Minimum length for a dashboard token. The only brute-force control is a per-IP
 *  rate limit, so a short/low-entropy token is realistically guessable by a
 *  distributed attacker (each source IP gets its own budget). Enforced at startup. */
export const MIN_TOKEN_LENGTH = 16;

/** Constant-time string comparison via fixed-length digests. */
export function tokenMatches(candidate: string, token: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** True when the request reached us over TLS, so the session cookie can be marked
 *  `Secure`. The dashboard is served directly (no proxy), so the request URL scheme
 *  is the trustworthy signal. Marking Secure on a plain-HTTP dev/loopback bind would
 *  make the browser silently drop the cookie and loop the login. */
function isHttpsRequest(c: Context): boolean {
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Set the authenticated session cookie (shared by the `?token=` and POST-form paths). */
function setSessionCookie(c: Context, value: string): void {
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(c),
    path: "/",
  });
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

const fails = new Map<string, { count: number; resetAt: number }>();

function clientKey(c: Context): string {
  // Direct connections only (the dashboard is not designed to sit behind a proxy
  // unauthenticated) — the socket address is the trustworthy identity we have.
  const info = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return info?.incoming?.socket?.remoteAddress ?? "unknown";
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = fails.get(key);
  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= MAX_FAILS;
}

function recordFailure(key: string): void {
  const now = Date.now();
  // Keep the map bounded on a long-running, internet-exposed server: sweep
  // expired entries once it grows past a cap (address-rotating attackers would
  // otherwise grow it for the life of the process).
  if (fails.size > 10_000) {
    for (const [k, v] of fails) {
      if (v.resetAt <= now) fails.delete(k);
    }
  }
  const entry = fails.get(key);
  if (!entry || entry.resetAt <= now) {
    fails.set(key, { count: 1, resetAt: now + FAIL_WINDOW_MS });
    return;
  }
  entry.count++;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unauthorized(c: Context, message: string): Response {
  return c.html(
    `<!doctype html><html lang="en" data-theme="night"><head><meta charset="utf-8"><title>Launch Pad</title><link rel="stylesheet" href="/dashboard.css"></head><body><div class="min-h-screen flex items-center justify-center bg-base-100"><div class="card bg-base-200 w-96"><div class="card-body"><h1 class="card-title">🚀 Launch Pad</h1><p class="text-sm opacity-70">${escapeHtml(message)}</p><form method="post" class="flex gap-2 mt-2"><input type="password" name="token" placeholder="access token" class="input input-bordered input-sm flex-1" autofocus /><button type="submit" class="btn btn-primary btn-sm">Unlock</button></form></div></div></div></body></html>`,
    401,
  );
}

/** Build the auth middleware for a configured token. */
export function authMiddleware(token: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (c.req.path === "/healthz" || c.req.path === "/dashboard.css") return next();

    // Rate-limit BEFORE evaluating any credential, and record every mismatched
    // credential (cookie, Bearer, query) — otherwise the header paths are an
    // unlimited-rate brute-force channel and the limiter only guards ?token=.
    const key = clientKey(c);
    if (rateLimited(key)) {
      return c.text("too many failed attempts — try again in a minute", 429);
    }

    const cookie = getCookie(c, COOKIE_NAME);
    if (cookie) {
      if (tokenMatches(cookie, token)) return next();
      // A stale cookie (rotated token) is re-sent by the browser on EVERY asset/page
      // load, so counting it as a failed attempt would trip the per-IP limiter after
      // ~10 loads and lock the (possibly NAT-shared) user out for a minute. Clear it
      // and fall through to an explicit credential path — don't record a failure.
      deleteCookie(c, COOKIE_NAME, { path: "/" });
    }

    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      if (tokenMatches(header.slice(7), token)) return next();
      recordFailure(key);
      return unauthorized(c, "That token didn't match. Check LAUNCH_PAD_DASHBOARD_TOKEN on the server.");
    }

    // Human login form posts the token in the request BODY (see `unauthorized`), so the
    // secret never lands in the URL / browser history / access logs — unlike a `?token=`
    // query, which is only kept as a convenience bootstrap for curl/API callers and is
    // immediately swapped for the cookie + redirected away.
    if (c.req.method === "POST") {
      const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const bodyToken = typeof body.token === "string" ? body.token : undefined;
      if (bodyToken) {
        if (tokenMatches(bodyToken, token)) {
          setSessionCookie(c, bodyToken);
          const url = new URL(c.req.url);
          return c.redirect(url.pathname + url.search);
        }
        recordFailure(key);
        return unauthorized(c, "That token didn't match. Check LAUNCH_PAD_DASHBOARD_TOKEN on the server.");
      }
    }

    const query = c.req.query("token");
    if (query) {
      if (tokenMatches(query, token)) {
        setSessionCookie(c, query);
        const url = new URL(c.req.url);
        url.searchParams.delete("token");
        return c.redirect(url.pathname + url.search);
      }
      recordFailure(key);
      return unauthorized(c, "That token didn't match. Check LAUNCH_PAD_DASHBOARD_TOKEN on the server.");
    }

    return unauthorized(c, "This dashboard requires an access token.");
  };
}
