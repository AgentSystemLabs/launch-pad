import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  type GetParametersCommandOutput,
  GetParametersByPathCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";

export async function putSecretParameter(
  ssm: SSMClient,
  name: string,
  value: string,
): Promise<void> {
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

export async function deleteSecretParameter(ssm: SSMClient, name: string): Promise<void> {
  await ssm.send(new DeleteParameterCommand({ Name: name }));
}

export async function getSecretParameter(ssm: SSMClient, name: string): Promise<string | null> {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return res.Parameter?.Value ?? null;
  } catch (error) {
    if (isParameterNotFound(error)) return null;
    throw error;
  }
}

/** SSM `GetParameters` accepts at most 10 names per call — batch larger lookups. */
const GET_PARAMETERS_MAX = 10;

/** Return parameter names that exist under the given full paths. */
export async function getExistingSecretPaths(
  ssm: SSMClient,
  paths: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  // Chunk by the API's 10-name limit so a service (or a bulk `secret import`) with
  // more than 10 keys doesn't trip a ValidationException.
  for (let i = 0; i < paths.length; i += GET_PARAMETERS_MAX) {
    const batch = paths.slice(i, i + GET_PARAMETERS_MAX);
    const res = await ssm.send(
      new GetParametersCommand({
        Names: batch,
        WithDecryption: false,
      }),
    );
    for (const p of res.Parameters ?? []) {
      if (p.Name) found.add(p.Name);
    }
  }
  return found;
}

export interface ListedSecret {
  name: string;
  path: string;
}

/** List all parameters under a prefix (names only — never returns values). */
export async function listSecretsByPrefix(
  ssm: SSMClient,
  prefix: string,
): Promise<ListedSecret[]> {
  const out: ListedSecret[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: false,
        WithDecryption: false,
        NextToken: nextToken,
      }),
    );
    for (const p of res.Parameters ?? []) {
      if (!p.Name) continue;
      const key = p.Name.slice(prefix.length + 1);
      if (key.length > 0) out.push({ name: key, path: p.Name });
    }
    nextToken = res.NextToken;
  } while (nextToken);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function isParameterNotFound(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: string }).name)
      : "";
  return name === "ParameterNotFound";
}

/** Classify missing keys from a GetParameters response. */
export function missingFromGetParameters(
  requested: string[],
  res: GetParametersCommandOutput,
): string[] {
  const found = new Set((res.Parameters ?? []).map((p) => p.Name).filter(Boolean) as string[]);
  return requested.filter((p) => !found.has(p));
}
