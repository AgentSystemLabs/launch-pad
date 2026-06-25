import { describe, it, expect, vi, beforeEach } from "vitest";
import { CreateTopicCommand, PublishCommand, SetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import { createOrGetTopic, publishDeployNotification } from "./sns";

// Mock SNSClient
vi.mock("@aws-sdk/client-sns");

describe("sns", () => {
  let mockSns: Partial<SNSClient>;

  beforeEach(() => {
    mockSns = {
      send: vi.fn(),
    };
  });

  it("createOrGetTopic creates topic with restrictive resource policy", async () => {
    const topicArn = "arn:aws:sns:us-east-1:123456789012:launch-pad-test-cluster";
    (mockSns.send as any)
      .mockResolvedValueOnce({ TopicArn: topicArn })
      .mockResolvedValueOnce({});

    const result = await createOrGetTopic(
      mockSns as SNSClient,
      "test-cluster",
      "us-east-1",
      "123456789012",
    );

    expect(result).toBe(topicArn);
    expect(mockSns.send).toHaveBeenCalledTimes(2);

    // Verify CreateTopicCommand was called
    const createCall = (mockSns.send as any).mock.calls[0][0];
    expect(createCall).toBeInstanceOf(CreateTopicCommand);

    // Verify SetTopicAttributesCommand was called with restrictive policy
    const policyCall = (mockSns.send as any).mock.calls[1][0];
    expect(policyCall).toBeInstanceOf(SetTopicAttributesCommand);
  });

  it("publishDeployNotification publishes versioned message to SNS", async () => {
    const topicArn = "arn:aws:sns:us-east-1:123456789012:launch-pad-test-cluster";
    (mockSns.send as any).mockResolvedValueOnce({ MessageId: "msg-123" });

    const result = await publishDeployNotification(mockSns as SNSClient, topicArn, {
      type: "config-changed",
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.000Z",
      version: 1,
    });

    expect(result).toBe("msg-123");
    expect(mockSns.send).toHaveBeenCalledTimes(1);

    const publishCall = (mockSns.send as any).mock.calls[0][0];
    expect(publishCall).toBeInstanceOf(PublishCommand);
  });
});
