import { describe, expect, it } from "vitest";
import type { Alert } from "./evaluate";
import { buildAlertPayload, isSecureWebhookUrl } from "./webhook";

const alert = (over: Partial<Alert> = {}): Alert => ({
  nodeId: "n1",
  kind: "heartbeat-stale",
  severity: "critical",
  message: "agent heartbeat is stale",
  ...over,
});

describe("buildAlertPayload", () => {
  it("summarizes count + critical count and lists each alert in text", () => {
    const p = buildAlertPayload("prod", [alert(), alert({ nodeId: "n2", severity: "warning", message: "slow" })]);
    expect(p.cluster).toBe("prod");
    expect(p.alertCount).toBe(2);
    expect(p.text).toContain('2 alerts on cluster "prod"');
    expect(p.text).toContain("(1 critical)");
    expect(p.text).toContain("n1: agent heartbeat is stale");
    expect(p.text).toContain("n2: slow");
    expect(p.alerts).toHaveLength(2);
  });

  it("uses singular phrasing for a single alert and omits the critical suffix when none", () => {
    const p = buildAlertPayload("dev", [alert({ severity: "warning" })]);
    expect(p.text).toContain('1 alert on cluster "dev"');
    expect(p.text).not.toContain("critical)");
  });
});

describe("isSecureWebhookUrl", () => {
  it("accepts HTTPS webhook URLs", () => {
    expect(isSecureWebhookUrl("https://hooks.slack.com/services/TOKEN")).toBe(true);
  });

  it("accepts loopback HTTP URLs for local test receivers", () => {
    expect(isSecureWebhookUrl("http://127.0.0.1:9000/hook")).toBe(true);
    expect(isSecureWebhookUrl("http://localhost:9000/hook")).toBe(true);
  });

  it("rejects plaintext HTTP to non-loopback hosts", () => {
    expect(isSecureWebhookUrl("http://hooks.slack.com/services/TOKEN")).toBe(false);
    expect(isSecureWebhookUrl("http://192.168.1.1/hook")).toBe(false);
  });

  it("rejects unsupported schemes and malformed URLs", () => {
    expect(isSecureWebhookUrl("ftp://example.com/hook")).toBe(false);
    expect(isSecureWebhookUrl("not a url")).toBe(false);
  });
});
