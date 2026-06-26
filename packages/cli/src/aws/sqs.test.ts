import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { ensureNodeQueue } from "./sqs";

describe("ensureNodeQueue", () => {
  let mockSqs: { send: ReturnType<typeof vi.fn> };
  let mockSns: { send: ReturnType<typeof vi.fn> };

  const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/launch-pad-prod-node-1";
  const queueArn = "arn:aws:sqs:us-east-1:123456789012:launch-pad-prod-node-1";
  const topicArn = "arn:aws:sns:us-east-1:123456789012:launch-pad-prod";

  beforeEach(() => {
    mockSqs = { send: vi.fn() };
    mockSns = { send: vi.fn().mockResolvedValue({ SubscriptionArn: "sub-arn" }) };
    mockSqs.send
      .mockResolvedValueOnce({ QueueUrl: queueUrl }) // CreateQueue
      .mockResolvedValueOnce({ Attributes: { QueueArn: queueArn } }) // GetQueueAttributes
      .mockResolvedValueOnce({}); // SetQueueAttributes
  });

  it("creates the queue named launch-pad-<cluster>-<node> and returns its URL", async () => {
    const url = await ensureNodeQueue(
      mockSqs as unknown as SQSClient,
      mockSns as unknown as SNSClient,
      "prod",
      "node-1",
      topicArn,
    );

    expect(url).toBe(queueUrl);
    const createCmd = mockSqs.send.mock.calls[0]![0];
    expect(createCmd).toBeInstanceOf(CreateQueueCommand);
    expect(createCmd.input.QueueName).toBe("launch-pad-prod-node-1");
  });

  it("reads the queue ARN before setting the policy", async () => {
    await ensureNodeQueue(
      mockSqs as unknown as SQSClient,
      mockSns as unknown as SNSClient,
      "prod",
      "node-1",
      topicArn,
    );
    const getAttrsCmd = mockSqs.send.mock.calls[1]![0];
    expect(getAttrsCmd).toBeInstanceOf(GetQueueAttributesCommand);
    expect(getAttrsCmd.input.AttributeNames).toContain("QueueArn");
  });

  it("sets a queue policy restricting SendMessage to this cluster's topic", async () => {
    await ensureNodeQueue(
      mockSqs as unknown as SQSClient,
      mockSns as unknown as SNSClient,
      "prod",
      "node-1",
      topicArn,
    );

    const setAttrsCmd = mockSqs.send.mock.calls[2]![0];
    expect(setAttrsCmd).toBeInstanceOf(SetQueueAttributesCommand);
    const policy = JSON.parse(setAttrsCmd.input.Attributes.Policy);
    const stmt = policy.Statement[0];
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Principal).toEqual({ Service: "sns.amazonaws.com" });
    expect(stmt.Action).toBe("sqs:SendMessage");
    expect(stmt.Resource).toBe(queueArn);
    // SourceArn condition is what prevents OTHER topics/principals from posting.
    expect(stmt.Condition.ArnEquals["aws:SourceArn"]).toBe(topicArn);
  });

  it("subscribes the queue to the topic with raw message delivery", async () => {
    await ensureNodeQueue(
      mockSqs as unknown as SQSClient,
      mockSns as unknown as SNSClient,
      "prod",
      "node-1",
      topicArn,
    );

    const subCmd = mockSns.send.mock.calls[0]![0];
    expect(subCmd).toBeInstanceOf(SubscribeCommand);
    expect(subCmd.input.TopicArn).toBe(topicArn);
    expect(subCmd.input.Protocol).toBe("sqs");
    expect(subCmd.input.Endpoint).toBe(queueArn);
    expect(subCmd.input.Attributes.RawMessageDelivery).toBe("true");
  });
});
