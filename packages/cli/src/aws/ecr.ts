import {
  CreateRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  type ECRClient,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";
import { CliError } from "../errors";
import { awsErrorName } from "./errors";

/** Idempotently ensure an ECR repository exists; returns its repository URI. */
export async function ensureRepository(ecr: ECRClient, name: string): Promise<string> {
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
    const uri = res.repositories?.[0]?.repositoryUri;
    if (uri) return uri;
  } catch (error) {
    if (awsErrorName(error) !== "RepositoryNotFoundException") throw error;
  }

  const created = await ecr.send(
    new CreateRepositoryCommand({
      repositoryName: name,
      imageTagMutability: "IMMUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
    }),
  );
  const uri = created.repository?.repositoryUri;
  if (!uri) throw new CliError(`failed to create ECR repository ${name}`);
  return uri;
}

/** Does an image with this tag already exist in the repo? (idempotent re-deploys) */
export async function imageExists(ecr: ECRClient, repository: string, tag: string): Promise<boolean> {
  try {
    const res = await ecr.send(
      new DescribeImagesCommand({ repositoryName: repository, imageIds: [{ imageTag: tag }] }),
    );
    return (res.imageDetails?.length ?? 0) > 0;
  } catch (error) {
    if (awsErrorName(error) === "ImageNotFoundException") return false;
    if (awsErrorName(error) === "RepositoryNotFoundException") return false;
    throw error;
  }
}

export interface EcrAuth {
  username: string;
  password: string;
  /** Registry endpoint, e.g. https://<account>.dkr.ecr.<region>.amazonaws.com */
  endpoint: string;
}

/** Fetch an ECR docker-login credential (valid ~12h). */
export async function getEcrAuth(ecr: ECRClient): Promise<EcrAuth> {
  const res = await ecr.send(new GetAuthorizationTokenCommand({}));
  const auth = res.authorizationData?.[0];
  if (!auth?.authorizationToken || !auth.proxyEndpoint) {
    throw new CliError("failed to obtain an ECR authorization token");
  }
  const decoded = Buffer.from(auth.authorizationToken, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  return {
    username: decoded.slice(0, sep),
    password: decoded.slice(sep + 1),
    endpoint: auth.proxyEndpoint,
  };
}

/** The registry host (no scheme), e.g. <account>.dkr.ecr.<region>.amazonaws.com */
export function registryHost(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "");
}
