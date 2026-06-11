/**
 * Post-deploy DNS checklist: for every web domain, the Elastic IP its A record
 * should point at. Pure + color-free so it's unit-tested; `deploy` renders the
 * returned lines inside a panel and includes the structured targets in --json.
 * Answers the #1 first-deploy question — "what do I point my domain at?" — instead
 * of only printing the https:// URL.
 */

export interface DnsTarget {
  domain: string;
  /** The node that fronts the domain — its edge (split) or its own node (co-located). */
  frontingNode: string;
  /** True when `frontingNode` is a dedicated edge rather than the service's own node. */
  viaEdge: boolean;
  /** The fronting node's Elastic IP, or null when it isn't provisioned yet. */
  eip: string | null;
}

/**
 * Build the panel body. Each domain becomes a line with its A-record target; a domain
 * whose node has no public IP yet (not provisioned / paused) is called out instead of
 * silently dropped. Returns [] when there are no web domains (workers only).
 */
export function buildDnsChecklist(targets: DnsTarget[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.domain)) continue;
    seen.add(t.domain);
    const via = t.viaEdge ? `edge ${t.frontingNode}` : `node ${t.frontingNode}`;
    lines.push(
      t.eip
        ? `${t.domain}  →  A  ${t.eip}  (${via})`
        : `${t.domain}  →  A  (${via} has no public IP yet — provision/resume it)`,
    );
  }
  if (lines.length === 0) return [];
  lines.push("add a DNS-only A record for each (Cloudflare: grey cloud, not orange), then verify:");
  lines.push("  launch-pad dns verify <domain>");
  return lines;
}
