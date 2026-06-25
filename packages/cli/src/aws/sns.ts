import { CreateTopicCommand, PublishCommand, SetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import type { SnsDeployNotification } from "@agentsystemlabs/launch-pad-shared";

export async function createOrGetTopic(
  sns: SNSClient,
  clusterId: string,
  region: string,
  accountId: string,
): Promise<string> {
  const topicName = `launch-pad-${clusterId}`;
  const command = new CreateTopicCommand({ Name: topicName });
  const result = await sns.send(command);
  const topicArn = result.TopicArn!;

  // Restrict topic access: only AWS account root can publish (prevents cross-principal/cluster notifications).
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RestrictPublishToAccountRoot",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "SNS:Publish",
        Resource: topicArn,
      },
    ],
  };
  await sns.send(
    new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: "Policy",
      AttributeValue: JSON.stringify(policy),
    }),
  );

  return topicArn;
}

export async function publishDeployNotification(
  sns: SNSClient,
  topicArn: string,
  notification: SnsDeployNotification,
): Promise<string> {
  const command = new PublishCommand({
    TopicArn: topicArn,
    Message: JSON.stringify(notification),
    Subject: `Deploy notification for ${notification.cluster}`,
  });
  const result = await sns.send(command);
  return result.MessageId!;
}
