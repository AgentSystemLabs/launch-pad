/**
 * Pure DNS-target planning for `launch-pad dns verify` / `dns setup`. Given a loaded
 * config, the deploy env, and the cluster's default edge, derive the (service, projected
 * domain, fronting node) tuple for every web service — without touching AWS. The command
 * then resolves each fronting node's Elastic IP from the registry. Kept pure so the
 * load-bearing parts — env domain projection and the co-located-vs-edge fronting decision —
 * are unit-tested.
 */
import {
  isWebService,
  type LaunchPadConfig,
  resolveServiceDomain,
  targetNodes,
} from "@agentsystemlabs/launch-pad-shared";

export interface DnsTarget {
  /** The service the domain belongs to. */
  service: string;
  /** The (env-projected) domain that needs an A record. */
  domain: string;
  /**
   * The node id whose Elastic IP the A record should target — its dedicated edge, or
   * (co-located) its own pinned node. `null` when it can't be determined statically: a
   * cluster-placed co-located service is served from whatever node the scheduler picked.
   */
  frontingNode: string | null;
}

/**
 * Map every web service in `config` to its A-record target. Worker services (no
 * domain/port) are skipped. `clusterDefaultEdge` is the cluster's `defaultEdge` (or
 * null for the default cluster / no edge).
 */
export function planDnsTargets(
  config: LaunchPadConfig,
  env: string | undefined,
  clusterDefaultEdge: string | null,
): DnsTarget[] {
  const targets: DnsTarget[] = [];
  for (const s of config.service) {
    if (!isWebService(s)) continue;
    const domain = resolveServiceDomain(
      { domain: s.domain, domainPattern: s.domainPattern ?? config.domainPattern, service: s.name },
      env,
    );
    if (domain === undefined) continue;

    // A co-located cluster-placed service deliberately ignores the cluster default edge —
    // it serves the domain from its own (scheduler-picked) node, which is unknowable here.
    const inheritedEdge = s.topology === "co-located" ? null : clusterDefaultEdge;
    const edge = s.edge ?? inheritedEdge;
    const frontingNode = edge ?? targetNodes(s)[0] ?? null;

    targets.push({ service: s.name, domain, frontingNode });
  }
  return targets;
}

/** A Route53 hosted zone, as the longest-suffix matcher needs it. */
export interface HostedZone {
  /** The zone id, e.g. "/hostedzone/Z123" (or the bare id). */
  id: string;
  /** The zone's DNS name, with or without a trailing dot. */
  name: string;
}

const stripDot = (s: string): string => s.replace(/\.$/, "");

/**
 * Pick the hosted zone whose name is the longest suffix of `domain` (so a delegated
 * `app.example.com` zone wins over `example.com` for `api.app.example.com`). Matches only
 * on a dot boundary or an exact apex — "notexample.com" never matches the "example.com"
 * zone. Returns null when no zone covers the domain, or for zones missing an id.
 */
export function selectHostedZone(zones: readonly HostedZone[], domain: string): HostedZone | null {
  const target = stripDot(domain);
  const candidates = zones
    .map((z) => ({ id: z.id, name: stripDot(z.name) }))
    .filter((z) => z.id.length > 0 && (target === z.name || target.endsWith(`.${z.name}`)))
    .sort((a, b) => b.name.length - a.name.length);
  return candidates[0] ?? null;
}
