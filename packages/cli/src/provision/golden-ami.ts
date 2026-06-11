import { DescribeImagesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { NodeAgentType } from "@agentsystemlabs/launch-pad-shared";
import { resolveLatestAl2023Ami } from "../aws/ssm";
import { CliError } from "../errors";
import rawManifest from "./golden-ami-manifest.json";

export type AmiBootstrapMode = "full" | "golden";
export type AmiSource = "explicit" | "env" | "golden" | "al2023";

export interface GoldenAmiEntry {
  amiId: string;
  region: string;
  architecture: "x86_64";
  agentType: NodeAgentType;
  agentVersion: string;
  builtAt: string;
  name?: string;
  sourceAmiId?: string;
  sourceAmiName?: string;
}

export interface GoldenAmiManifest {
  schemaVersion: 1;
  defaultAgentType: NodeAgentType;
  amis: Record<string, GoldenAmiEntry>;
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

  const entry = amiManifest.amis[params.region];
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
