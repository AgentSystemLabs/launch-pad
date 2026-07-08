import { CliError } from "../errors";

/** IPv4 CIDR blocks allowed for SSH ingress (must not be world-open). */
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[1-2][0-9]|3[0-2])$/;

const WORLD_OPEN = new Set(["0.0.0.0/0", "::/0"]);

function ipv4OctetsValid(cidr: string): boolean {
  const [addr] = cidr.split("/");
  if (!addr) return false;
  return addr.split(".").every((octet) => {
    const n = Number.parseInt(octet, 10);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/**
 * Validate an SSH ingress CIDR. Rejects world-open ranges so port 22 is never
 * exposed to the entire internet by default.
 */
export function parseSshCidr(raw: string): string {
  const cidr = raw.trim();
  if (!cidr) {
    throw new CliError("invalid --ssh-cidr (expected an IPv4 CIDR, e.g. 203.0.113.10/32)");
  }
  if (WORLD_OPEN.has(cidr)) {
    throw new CliError(`--ssh-cidr ${cidr} is not allowed — restrict SSH to your IP (e.g. 203.0.113.10/32)`, {
      hint: "launch-pad nodes support AWS SSM Session Manager for remote shell access without opening port 22",
    });
  }
  if (!IPV4_CIDR.test(cidr) || !ipv4OctetsValid(cidr)) {
    throw new CliError(`invalid --ssh-cidr "${raw}" (expected an IPv4 CIDR, e.g. 203.0.113.10/32)`);
  }
  return cidr;
}
