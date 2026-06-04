import { ECRClient } from "@aws-sdk/client-ecr";
import { S3Client } from "@aws-sdk/client-s3";

export interface AgentClients {
  s3: S3Client;
  ecr: ECRClient;
}

/**
 * Construct the AWS clients. Credentials come from the default provider chain,
 * which on EC2 resolves the instance role via IMDSv2 — so no keys are needed.
 */
export function makeClients(region: string): AgentClients {
  return { s3: new S3Client({ region }), ecr: new ECRClient({ region }) };
}
