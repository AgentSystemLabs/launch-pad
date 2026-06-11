import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { type ServiceConfig } from "@agentsystemlabs/launch-pad-shared";

let ssm: SSMClient | null = null;
let configuredRegion: string | undefined;

/** Configure the AWS region from the agent config written at provision time. */
export function configureSecretsRegion(region: string): void {
  if (configuredRegion === region) return;
  configuredRegion = region;
  ssm = null;
}

/** Test hook — inject a mock SSM client. */
export function setSsmClientForTest(client: SSMClient | null): void {
  ssm = client;
}

function client(): SSMClient {
  if (!ssm) ssm = new SSMClient({ region: configuredRegion });
  return ssm;
}

/**
 * Resolve secretRefs from SSM and merge with plain env. Plain env wins on collision.
 */
export async function resolveServiceEnv(config: ServiceConfig): Promise<Record<string, string>> {
  const refs = config.secretRefs ?? [];
  const resolved: Record<string, string> = {};

  if (refs.length > 0) {
    const names = refs.map((r) => r.ssm);
    const res = await client().send(
      new GetParametersCommand({
        Names: names,
        WithDecryption: true,
      }),
    );
    const byName = new Map((res.Parameters ?? []).map((p) => [p.Name, p.Value]));
    for (const ref of refs) {
      const value = byName.get(ref.ssm);
      if (value === undefined) {
        throw new Error(`SSM parameter not found: ${ref.ssm} (${ref.name})`);
      }
      resolved[ref.name] = value;
    }
  }

  return { ...resolved, ...config.env };
}
