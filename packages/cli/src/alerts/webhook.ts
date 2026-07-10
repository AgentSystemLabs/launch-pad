import type { Alert } from "./evaluate";

export interface AlertPayload {
  /** Human summary — also what Slack/Discord incoming webhooks render. */
  text: string;
  cluster: string;
  alertCount: number;
  alerts: Alert[];
}

/**
 * Build the webhook body for a set of alerts. `text` is a Slack/Discord-compatible
 * summary (those render the `text` field); structured consumers read `alerts`.
 */
export function buildAlertPayload(cluster: string, alerts: Alert[]): AlertPayload {
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const summary =
    `🚨 launch-pad: ${alerts.length} alert${alerts.length === 1 ? "" : "s"} on cluster "${cluster}"` +
    (critical > 0 ? ` (${critical} critical)` : "");
  const lines = alerts.map((a) => `• [${a.severity}] ${a.nodeId}: ${a.message}`);
  return { text: [summary, ...lines].join("\n"), cluster, alertCount: alerts.length, alerts };
}

/** The origin of a URL for error messages — a Slack/Discord webhook embeds its TOKEN in the
 *  path, so never log the full URL (it could land in CI logs and be replayed). */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<webhook>";
  }
}

/** True when `host` is an IPv4/IPv6 literal in a private, loopback, or link-local range.
 *  These must never be a webhook target (SSRF) — link-local covers the cloud metadata
 *  endpoint 169.254.169.254. Hostnames that are not IP literals are left to DNS (best
 *  effort — a name resolving to a private IP is out of scope; the redirect and
 *  literal-IP guards below are the primary defense). */
function isPrivateOrLinkLocalHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/** Webhook URLs carry alert details and often embed secret tokens, so require TLS.
 *  Loopback addresses (127.0.0.1, localhost) are exempt so e2e tests can use a local HTTP
 *  receiver — but any other private/link-local literal (e.g. the metadata endpoint) is
 *  rejected so the webhook can't be pointed at internal infrastructure (SSRF). */
export function isSecureWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    // Loopback over plain HTTP is the only allowed non-TLS/private target (e2e receivers).
    if (parsed.protocol === "http:" && loopback) return true;
    if (parsed.protocol !== "https:") return false;
    // TLS is required for everything else; block internal/link-local literals.
    if (!loopback && isPrivateOrLinkLocalHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** POST an alert payload to a webhook URL. Throws on a non-2xx response.
 *  `redirect: "manual"` means a redirect is a hard failure rather than being followed:
 *  the up-front `isSecureWebhookUrl` check only validates the FIRST hop, so following a
 *  3xx would let a malicious/compromised endpoint bounce the POST (with its secret-bearing
 *  body) to an internal host or the metadata endpoint (SSRF). */
export async function postWebhook(url: string, payload: AlertPayload): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error(`webhook POST to ${safeOrigin(url)} refused: server attempted a redirect (not followed for SSRF safety)`);
  }
  if (!res.ok) {
    throw new Error(`webhook POST to ${safeOrigin(url)} failed: ${res.status} ${res.statusText}`);
  }
}
