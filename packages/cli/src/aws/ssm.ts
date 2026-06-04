import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { CliError } from "../errors";

/** Public SSM parameter for the latest Amazon Linux 2023 x86_64 AMI. */
const AL2023_X86_64_PARAM =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";

export async function resolveLatestAl2023Ami(ssm: SSMClient): Promise<string> {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: AL2023_X86_64_PARAM }));
    const id = res.Parameter?.Value;
    if (id) return id;
  } catch {
    /* fall through to a single clear error */
  }
  throw new CliError("could not resolve the latest Amazon Linux 2023 AMI", {
    hint: "pass --ami <id> explicitly",
  });
}
