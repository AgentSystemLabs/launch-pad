import { type ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { execa } from "execa";

const LOGIN_TTL_MS = 6 * 60 * 60 * 1000; // ECR tokens last ~12h; refresh well before.
let lastLoginAt = 0;

/** docker login to ECR using the instance role; cached so we don't login every tick. */
export async function ensureEcrLogin(ecr: ECRClient, force = false): Promise<void> {
  if (!force && Date.now() - lastLoginAt < LOGIN_TTL_MS) return;

  const res = await ecr.send(new GetAuthorizationTokenCommand({}));
  const auth = res.authorizationData?.[0];
  if (!auth?.authorizationToken || !auth.proxyEndpoint) {
    throw new Error("ECR returned no authorization token");
  }
  const decoded = Buffer.from(auth.authorizationToken, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const host = auth.proxyEndpoint.replace(/^https?:\/\//, "");

  await execa("docker", ["login", "--username", "AWS", "--password-stdin", host], {
    input: password,
  });
  lastLoginAt = Date.now();
}
