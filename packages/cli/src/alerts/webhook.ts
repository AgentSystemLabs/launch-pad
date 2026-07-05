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

/** Webhook URLs carry alert details and often embed secret tokens, so require TLS.
 *  Loopback addresses (127.0.0.1, localhost) are exempt so e2e tests can use a local HTTP receiver. */
export function isSecureWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

/** POST an alert payload to a webhook URL. Throws on a non-2xx response. */
export async function postWebhook(url: string, payload: AlertPayload): Promise<void> {
  if (!isSecureWebhookUrl(url)) {
    throw new Error(`webhook URL must use HTTPS: ${safeOrigin(url)}`);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`webhook POST to ${safeOrigin(url)} failed: ${res.status} ${res.statusText}`);
  }
}
