import { DescribeImagesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type {
  NodeAgentType,
  NodeArchitecture,
  ProvisionNodeRole,
} from "@agentsystemlabs/launch-pad-shared";
import { resolveLatestAl2023Ami } from "../aws/ssm";
import { CliError } from "../errors";
import rawManifest from "./golden-ami-manifest.json";

export type AmiBootstrapMode = "full" | "golden";
export type AmiSource = "explicit" | "env" | "golden" | "al2023";

export interface GoldenAmiEntry {
  amiId: string;
  region: string;
  architecture: NodeArchitecture;
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
 *
 * v3 adds architecture beneath each role:
 * `amis.edge.arm64[region]` / `amis.app.x86_64[region]`.
 */
export type GoldenAmiManifest = GoldenAmiManifestV2 | GoldenAmiManifestV3;

export interface GoldenAmiManifestV2 {
  schemaVersion: 2;
  defaultAgentType: NodeAgentType;
  amis: Record<ProvisionNodeRole, Record<string, GoldenAmiEntry>>;
}

export interface GoldenAmiManifestV3 {
  schemaVersion: 3;
  defaultAgentType: NodeAgentType;
  amis: Record<ProvisionNodeRole, Record<NodeArchitecture, Record<string, GoldenAmiEntry>>>;
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
  architecture: NodeArchitecture;
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

function lookupManifestEntry(
  amiManifest: GoldenAmiManifest,
  role: ProvisionNodeRole,
  architecture: NodeArchitecture,
  region: string,
): GoldenAmiEntry | undefined {
  if (amiManifest.schemaVersion === 3) {
    return amiManifest.amis[role]?.[architecture]?.[region];
  }
  const legacy = amiManifest.amis[role]?.[region];
  if (!legacy) return undefined;
  return legacy.architecture === architecture ? legacy : undefined;
}

/**
 * Resolve the AMI for a node by role + region, in precedence order:
 * `--ami` flag → `LAUNCHPAD_AMI_ID` env (applies to BOTH roles — set
 * `LAUNCHPAD_AMI_BOOTSTRAP=full` if it's not a launchpad golden image) →
 * the role+architecture golden manifest entry (verified available) → latest AL2023 with a
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

  const entry = lookupManifestEntry(amiManifest, params.role, params.architecture, params.region);
  if (entry && (await canDescribeAmi(params.ec2, entry.amiId))) {
    return {
      imageId: entry.amiId,
      source: "golden",
      bootstrapMode: "golden",
      manifestEntry: entry,
    };
  }

  return {
    imageId: await resolveLatestAl2023Ami(params.ssm, params.architecture),
    source: "al2023",
    bootstrapMode: "full",
  };
}

export type AmiLookupKey = `${ProvisionNodeRole}:${NodeArchitecture}`;
export interface ResolveNodeAmiSpec {
  role: ProvisionNodeRole;
  architecture: NodeArchitecture;
}

export function nodeAmiLookupKey(spec: ResolveNodeAmiSpec): AmiLookupKey {
  return `${spec.role}:${spec.architecture}`;
}

/**
 * Resolve the AMI for each role+architecture pair in `specs` (a mixed provisioning
 * batch may need edge/app and x86/ARM images).
 */
export async function resolveNodeAmiByRole(
  params: Omit<ResolveNodeAmiParams, "role" | "architecture">,
  specs: Iterable<ResolveNodeAmiSpec>,
  amiManifest: GoldenAmiManifest = manifest,
): Promise<Map<AmiLookupKey, ResolvedNodeAmi>> {
  const out = new Map<AmiLookupKey, ResolvedNodeAmi>();
  const seen = new Set<AmiLookupKey>();
  for (const spec of specs) {
    const key = nodeAmiLookupKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(key, await resolveNodeAmi({ ...params, ...spec }, amiManifest));
  }
  return out;
}

/** Collapse a registry NodeRole (which may be the legacy "both") to a provisionable role. */
export function provisionRoleOf(role: string): ProvisionNodeRole {
  return role === "app" ? "app" : "edge";
}
