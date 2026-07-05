import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { NodeArchitecture } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "../errors";

const AL2023_PARAM: Record<NodeArchitecture, string> = {
  x86_64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  arm64: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
};

export async function resolveLatestAl2023Ami(
  ssm: SSMClient,
  architecture: NodeArchitecture = "x86_64",
): Promise<string> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: AL2023_PARAM[architecture] }));
    const id = res.Parameter?.Value;
    if (id) return id;
  } catch {
    /* fall through to a single clear error */
  }
  throw new CliError("could not resolve the latest Amazon Linux 2023 AMI", {
    hint: `pass --ami <id> explicitly (needed ${architecture})`,
  });
}
