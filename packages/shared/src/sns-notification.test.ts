import { describe, it, expect } from "vitest";
import { SnsDeployNotificationSchema, SNS_NOTIFICATION_VERSION } from "./sns-notification";

describe("SnsDeployNotification", () => {
  it("validates config-changed message with version", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.000Z",
      version: SNS_NOTIFICATION_VERSION,
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).not.toThrow();
  });

  it("rejects message without version", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.000Z",
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).toThrow();
  });

  it("validates ISO 8601 timestamp with milliseconds", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.123Z",
      version: SNS_NOTIFICATION_VERSION,
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).not.toThrow();
  });

  it("validates ISO 8601 timestamp without milliseconds", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00Z",
      version: SNS_NOTIFICATION_VERSION,
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).not.toThrow();
  });

  it("rejects invalid timestamp format", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "not-a-timestamp",
      version: SNS_NOTIFICATION_VERSION,
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).toThrow();
  });

  it("rejects unknown message types", () => {
    const message = {
      type: "unknown-type" as any,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.000Z",
      version: SNS_NOTIFICATION_VERSION,
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).toThrow();
  });

  it("rejects extra properties", () => {
    const message = {
      type: "config-changed" as const,
      cluster: "test-cluster",
      timestamp: "2026-03-05T12:00:00.000Z",
      version: SNS_NOTIFICATION_VERSION,
      extra: "field",
    };

    expect(() => SnsDeployNotificationSchema.parse(message)).toThrow();
  });
});
