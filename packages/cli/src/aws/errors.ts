import { CliError } from "../errors";

interface AwsLikeError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

export function awsErrorName(error: unknown): string | undefined {
  return (error as AwsLikeError | undefined)?.name;
}

export function awsStatusCode(error: unknown): number | undefined {
  return (error as AwsLikeError | undefined)?.$metadata?.httpStatusCode;
}

/**
 * Translate the common AWS auth/permission failures into a CliError with a helpful
 * hint. Re-throws anything else unchanged.
 */
export function rethrowAwsError(error: unknown, context: string): never {
  const name = awsErrorName(error);
  const message = (error as AwsLikeError).message ?? String(error);

  if (
    name === "CredentialsProviderError" ||
    name === "InvalidClientTokenId" ||
    name === "UnrecognizedClientException"
  ) {
    throw new CliError(`${context}: AWS credentials are missing or invalid`, {
      hint: "configure them with `aws configure` or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY",
    });
  }
  if (name === "AccessDenied" || name === "AccessDeniedException") {
    throw new CliError(`${context}: access denied — ${message}`, {
      hint: "your IAM user is missing a permission for this action",
    });
  }
  if (name === "ExpiredToken" || name === "ExpiredTokenException") {
    throw new CliError(`${context}: your AWS session token has expired`, {
      hint: "refresh your credentials and try again",
    });
  }
  throw error;
}
