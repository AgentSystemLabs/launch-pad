const IMDS_BASE = "http://169.254.169.254";
const IMDS_LOCAL_IP = `${IMDS_BASE}/latest/meta-data/local-ipv4`;

let cachedPrivateIp: string | null = null;

/** IMDSv2 session token (required when HttpTokens=required on the instance). */
async function imdsToken(): Promise<string> {
  const res = await fetch(`${IMDS_BASE}/latest/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) {
    throw new Error(`IMDS token returned ${res.status}`);
  }
  return res.text();
}

/** EC2 instance private IPv4 via IMDS (cached for the process lifetime). */
export async function getPrivateIp(): Promise<string> {
  if (cachedPrivateIp) return cachedPrivateIp;
  const token = await imdsToken();
  const res = await fetch(IMDS_LOCAL_IP, {
    headers: { "X-aws-ec2-metadata-token": token },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) {
    throw new Error(`IMDS local-ipv4 returned ${res.status}`);
  }
  const ip = (await res.text()).trim();
  if (!ip) throw new Error("IMDS local-ipv4 returned empty body");
  cachedPrivateIp = ip;
  return ip;
}
