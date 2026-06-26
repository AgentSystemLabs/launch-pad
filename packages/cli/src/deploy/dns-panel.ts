/**
 * Post-deploy DNS checklist: for every web domain, the Elastic IP its A record
 * should point at. Pure + color-free so it's unit-tested; `deploy` renders the
 * returned lines inside a panel and includes the structured targets in --json.
 * Answers the #1 first-deploy question — "what do I point my domain at?" — instead
 * of only printing the https:// URL.
 */

export interface DnsTarget {
  domain: string;
  /** The node that fronts the domain — the cluster's dedicated edge. */
  frontingNode: string;
  /** True when `frontingNode` is a dedicated edge rather than the service's own node. */
  viaEdge: boolean;
  /** The fronting node's Elastic IP, or null when it isn't provisioned yet. */
  eip: string | null;
}

/**
 * The single wildcard record that covers every projection of a `domainPattern`, or
 * null when one wildcard label can't ("{service}.{env}.example.com" varies two labels).
 * "{service}-{env}.example.com" → "*.example.com".
 */
export function wildcardForPattern(pattern: string): string | null {
  const labels = pattern.split(".");
  let varying = 0;
  while (varying < labels.length && (labels[varying] ?? "").includes("{")) varying += 1;
  const rest = labels.slice(varying);
  if (varying !== 1 || rest.length < 2 || rest.some((l) => l.includes("{"))) return null;
  return `*.${rest.join(".")}`;
}

/** Placeholder shown in place of the edge IP when the checklist is rendered with `hideIp`. */
export const HIDDEN_EIP = "•••.•••.•••.•••";

export interface DnsChecklistOptions {
  /**
   * Redact the edge's Elastic IP from the rendered lines (replace it with {@link HIDDEN_EIP}).
   * Set on CI/public-log runs so a deploy log can't leak the origin IP behind a proxy/CDN.
   * Affects the human panel only — the structured `--json` targets keep the real IP.
   */
  hideIp?: boolean;
}

/**
 * Build the panel body. Each domain becomes a line with its A-record target; a domain
 * whose node has no public IP yet (not provisioned / paused) is called out instead of
 * silently dropped. When the project has a `domainPattern` a single wildcard covers
 * every env projection, so `wildcard` adds that hint. Returns [] when there are no
 * web domains (workers only).
 *
 * With `opts.hideIp`, every IP is masked ({@link HIDDEN_EIP}) and a reveal hint is
 * appended — so a public CI log never carries the origin IP.
 */
export function buildDnsChecklist(
  targets: DnsTarget[],
  wildcard?: string | null,
  opts?: DnsChecklistOptions,
): string[] {
  const hideIp = opts?.hideIp === true;
  const showEip = (ip: string): string => (hideIp ? HIDDEN_EIP : ip);
  const lines: string[] = [];
  const seen = new Set<string>();
  let eip: string | null = null;
  for (const t of targets) {
    if (seen.has(t.domain)) continue;
    seen.add(t.domain);
    eip = eip ?? t.eip;
    const via = t.viaEdge ? `edge ${t.frontingNode}` : `node ${t.frontingNode}`;
    lines.push(
      t.eip
        ? `${t.domain}  →  A  ${showEip(t.eip)}  (${via})`
        : `${t.domain}  →  A  (${via} has no public IP yet — provision/resume it)`,
    );
  }
  if (lines.length === 0) return [];
  if (wildcard && eip) {
    lines.push(`or one wildcard covers every env subdomain:  ${wildcard}  →  A  ${showEip(eip)}`);
  }
  lines.push("add a DNS A record for each (must resolve directly to the edge IP — not via a proxy/CDN), then verify:");
  lines.push("  launchpad dns verify <domain>");
  if (hideIp) {
    lines.push("edge IP hidden in this log — run a local `launchpad deploy` (or `--show-ip`) to reveal it.");
  }
  return lines;
}
