/**
 * Pure DNS verdict logic for `launch-pad dns verify`. The command resolves the live
 * records (via node:dns) and the expected Elastic IP (from the cluster registry), then
 * hands both here. Kept pure + side-effect-free so the tricky parts — Cloudflare-range
 * detection and the "right IP?" decision — are unit-tested without touching the network.
 */

/**
 * Cloudflare's published IPv4 proxy ranges (https://www.cloudflare.com/ips-v4). A
 * domain whose A record sits in one of these is **orange-clouded** (proxied) — which
 * breaks Caddy's Let's Encrypt HTTP-01/TLS-ALPN challenge, because the challenge never
 * reaches the node. This is the single most common first-deploy HTTPS footgun.
 */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

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

/** True when `ip` falls inside `cidr` (e.g. "104.16.0.0/13"). False on any malformed input. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  if (base === undefined || prefixStr === undefined) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  // A /0 mask is all-zero; the shift below is undefined for 32, so special-case it.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True when `ip` is in any Cloudflare proxy range. */
export function isCloudflareIp(ip: string): boolean {
  return CLOUDFLARE_IPV4_RANGES.some((cidr) => ipv4InCidr(ip, cidr));
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
  | "cloudflare-proxied"
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

  if (a.some(isCloudflareIp)) {
    return {
      ...base,
      status: "cloudflare-proxied",
      ok: false,
      message:
        `A record resolves to a Cloudflare proxy IP (${a.join(", ")})${cnameNote} — the orange-cloud proxy ` +
        "blocks Let's Encrypt HTTP-01, so the certificate can't issue. Set the record to DNS-only (grey cloud).",
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
