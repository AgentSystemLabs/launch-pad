/**
 * Pure DNS verdict logic for `launchpad dns verify`. The command resolves the live
 * records (via node:dns) and the expected Elastic IP (from the cluster registry), then
 * hands both here. Kept pure + side-effect-free so the "right IP?" decision is
 * unit-tested without touching the network.
 */

/** Parse a dotted-quad IPv4 to a uint32, or null when malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** True when `ip` is a well-formed dotted-quad IPv4 (each octet 0–255). */
export function isIpv4(ip: string): boolean {
  return ipv4ToInt(ip) !== null;
}

/** Live DNS resolution for a host, as the CLI observes it from node:dns. */
export interface DnsObservation {
  /** Resolved A records (IPv4), following any CNAME chain. */
  a: string[];
  /** Resolved AAAA records (IPv6), if any. */
  aaaa: string[];
  /** The CNAME the host points to, if it is a CNAME (informational). */
  cname: string | null;
}

export type DnsStatus =
  | "ok"
  | "wrong-ip"
  | "no-records"
  | "no-expected-ip";

export interface DnsVerdict {
  status: DnsStatus;
  /** True only for `ok`. */
  ok: boolean;
  /** Resolved A records. */
  ips: string[];
  aaaa: string[];
  cname: string | null;
  /** The Elastic IP the record should point at, or null when it couldn't be determined. */
  expectedIp: string | null;
  /** Human-readable explanation (also used as the warning/hint text). */
  message: string;
}

/** Classify how a domain's live DNS compares to the Elastic IP it should target. */
export function classifyDns(observation: DnsObservation, expectedIp: string | null): DnsVerdict {
  const { a, aaaa, cname } = observation;
  const base = { ips: a, aaaa, cname, expectedIp };
  const cnameNote = cname ? ` (via CNAME ${cname})` : "";

  if (a.length === 0) {
    return {
      ...base,
      status: "no-records",
      ok: false,
      message:
        cname !== null
          ? `resolves to CNAME ${cname} but no A record was found — point an A record at the node's Elastic IP`
          : "no A record found (NXDOMAIN or not yet created) — add an A record pointing at the node's Elastic IP",
    };
  }

  if (expectedIp === null) {
    return {
      ...base,
      status: "no-expected-ip",
      ok: false,
      message: `resolves to ${a.join(", ")}${cnameNote} — could not determine the expected Elastic IP to compare against`,
    };
  }

  if (a.includes(expectedIp)) {
    return {
      ...base,
      status: "ok",
      ok: true,
      message: `resolves to the node's Elastic IP ${expectedIp}${cnameNote}`,
    };
  }

  return {
    ...base,
    status: "wrong-ip",
    ok: false,
    message: `resolves to ${a.join(", ")}${cnameNote} but should point at the node's Elastic IP ${expectedIp}`,
  };
}
