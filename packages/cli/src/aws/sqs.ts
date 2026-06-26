import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";

/**
 * Idempotently ensure the per-node SQS queue that receives SNS deploy
 * notifications, and subscribe it to the cluster's topic. Named
 * `launch-pad-<cluster>-<node>` — the SAME name the agent derives and polls
 * (`agent-rust/src/sqs.rs`). Returns the queue URL.
 *
 * Steps (all idempotent — safe to re-run every deploy):
 *  1. CreateQueue        — returns the existing queue's URL if it already exists.
 *  2. GetQueueAttributes — read the queue ARN (needed for the policy + subscription).
 *  3. SetQueueAttributes — a resource policy letting ONLY this cluster's SNS topic
 *     `sqs:SendMessage` (SourceArn-conditioned), so no other principal/topic can post.
 *  4. Subscribe          — topic → queue with RawMessageDelivery, so the agent reads
 *     the published JSON directly (no SNS envelope to unwrap). Subscribe returns the
 *     existing subscription if the same topic+endpoint pair is already wired.
 */
export async function ensureNodeQueue(
  sqs: SQSClient,
  sns: SNSClient,
  clusterId: string,
  nodeId: string,
  topicArn: string,
): Promise<string> {
  const queueName = `launch-pad-${clusterId}-${nodeId}`;

  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
  if (!QueueUrl) throw new Error(`SQS CreateQueue returned no URL for ${queueName}`);

  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const queueArn = Attributes?.QueueArn;
  if (!queueArn) throw new Error(`could not resolve ARN for queue ${queueName}`);

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowClusterTopicSend",
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: queueArn,
        Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
      },
      {
        // Defense-in-depth: refuse any non-TLS access to the queue (CIS-style hardening).
        Sid: "DenyNonTls",
        Effect: "Deny",
        Principal: "*",
        Action: "sqs:*",
        Resource: queueArn,
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  };
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl,
      Attributes: { Policy: JSON.stringify(policy) },
    }),
  );

  await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: "sqs",
      Endpoint: queueArn,
      Attributes: { RawMessageDelivery: "true" },
      ReturnSubscriptionArn: true,
    }),
  );

  return QueueUrl;
}
