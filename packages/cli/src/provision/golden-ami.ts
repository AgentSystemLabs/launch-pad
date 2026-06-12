import { DescribeImagesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { NodeAgentType, ProvisionNodeRole } from "@agentsystemlabs/launch-pad-shared";
import { resolveLatestAl2023Ami } from "../aws/ssm";
import { CliError } from "../errors";
import rawManifest from "./golden-ami-manifest.json";

export type AmiBootstrapMode = "full" | "golden";
export type AmiSource = "explicit" | "env" | "golden" | "al2023";

export interface GoldenAmiEntry {
  amiId: string;
  region: string;
  architecture: "x86_64";
  /** Which node role this AMI is baked for (edge: Caddy, no Docker; app: Docker, no Caddy). */
  role: ProvisionNodeRole;
  agentType: NodeAgentType;
  agentVersion: string;
  builtAt: string;
  name?: string;
  sourceAmiId?: string;
  sourceAmiName?: string;
}

/**
 * v2: AMIs are ROLE-SPECIFIC — `amis.edge[region]` (Caddy + edge agent, no Docker or
 * Node.js) and `amis.app[region]` (Docker + app agent, no Caddy or Node.js). The CLI
 * picks the right one automatically from the node's role; users never choose unless
 * they opt in with `--ami`.
 */
export interface GoldenAmiManifest {
  schemaVersion: 2;
  defaultAgentType: NodeAgentType;
  amis: Record<ProvisionNodeRole, Record<string, GoldenAmiEntry>>;
}

export interface ResolvedNodeAmi {
  imageId: string;
  source: AmiSource;
  bootstrapMode: AmiBootstrapMode;
  manifestEntry?: GoldenAmiEntry;
}

export interface ResolveNodeAmiParams {
  ec2: EC2Client;
  ssm: SSMClient;
  region: string;
  /** The node role being provisioned — selects the role-specific golden AMI. */
  role: ProvisionNodeRole;
  explicitAmiId?: string;
  env?: NodeJS.ProcessEnv;
}

const manifest = rawManifest as GoldenAmiManifest;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function overrideBootstrapMode(
  env: NodeJS.ProcessEnv,
  defaultMode: AmiBootstrapMode,
): AmiBootstrapMode {
  const value = nonEmpty(env.LAUNCHPAD_AMI_BOOTSTRAP);
  if (value === undefined) return defaultMode;
  if (value === "full" || value === "golden") return value;
  throw new CliError(`invalid LAUNCHPAD_AMI_BOOTSTRAP="${value}"`, {
    hint: 'expected "full" or "golden"',
  });
}

async function canDescribeAmi(ec2: EC2Client, amiId: string): Promise<boolean> {
  try {
    const res = await ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
    return (res.Images ?? []).some((image) => image.ImageId === amiId && image.State === "available");
  } catch {
    return false;
  }
}

/**
 * Resolve the AMI for a node by role + region, in precedence order:
 * `--ami` flag → `LAUNCHPAD_AMI_ID` env (applies to BOTH roles — set
 * `LAUNCHPAD_AMI_BOOTSTRAP=full` if it's not a launchpad golden image) →
 * the role's golden manifest entry (verified available) → latest AL2023 with a
 * role-appropriate full bootstrap.
 */
export async function resolveNodeAmi(
  params: ResolveNodeAmiParams,
  amiManifest: GoldenAmiManifest = manifest,
): Promise<ResolvedNodeAmi> {
  const env = params.env ?? process.env;
  const explicit = nonEmpty(params.explicitAmiId);
  if (explicit) {
    return {
      imageId: explicit,
      source: "explicit",
      bootstrapMode: overrideBootstrapMode(env, "full"),
    };
  }

  const envAmi = nonEmpty(env.LAUNCHPAD_AMI_ID);
  if (envAmi) {
    return {
      imageId: envAmi,
      source: "env",
      bootstrapMode: overrideBootstrapMode(env, "golden"),
    };
  }

  const entry = amiManifest.amis[params.role]?.[params.region];
  if (entry && (await canDescribeAmi(params.ec2, entry.amiId))) {
    return {
      imageId: entry.amiId,
      source: "golden",
      bootstrapMode: "golden",
      manifestEntry: entry,
    };
  }

  return {
    imageId: await resolveLatestAl2023Ami(params.ssm),
    source: "al2023",
    bootstrapMode: "full",
  };
}

/**
 * Resolve the AMI for each role in `roles` (a mixed provisioning batch needs one per
 * role — the edge and app golden AMIs are different images).
 */
export async function resolveNodeAmiByRole(
  params: Omit<ResolveNodeAmiParams, "role">,
  roles: Iterable<ProvisionNodeRole>,
  amiManifest: GoldenAmiManifest = manifest,
): Promise<Map<ProvisionNodeRole, ResolvedNodeAmi>> {
  const out = new Map<ProvisionNodeRole, ResolvedNodeAmi>();
  for (const role of new Set(roles)) {
    out.set(role, await resolveNodeAmi({ ...params, role }, amiManifest));
  }
  return out;
}

/** Collapse a registry NodeRole (which may be the legacy "both") to a provisionable role. */
export function provisionRoleOf(role: string): ProvisionNodeRole {
  return role === "app" ? "app" : "edge";
}
