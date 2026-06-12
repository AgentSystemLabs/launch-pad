/**
 * Pure DNS-target planning for `launchpad dns verify`. Given a loaded config, the
 * deploy env, and the cluster's default edge, derive the (service, projected domain,
 * fronting node) tuple for every web service — without touching AWS. The command
 * then resolves each fronting node's Elastic IP from the registry. Kept pure so the
 * load-bearing parts — env domain projection and the co-located-vs-edge fronting decision —
 * are unit-tested.
 */
import {
  isWebService,
  type LaunchPadConfig,
  resolveServiceDomain,
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

    // Every web service routes through the cluster's dedicated edge.
    targets.push({ service: s.name, domain, frontingNode: clusterDefaultEdge });
  }
  return targets;
}
