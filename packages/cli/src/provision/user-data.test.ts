import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "./systemd-unit";
import { type AgentConfig, renderUserData } from "./user-data";

const agent: AgentConfig = {
  nodeId: "node-prod-1",
  agentId: "agent-node-prod-1",
  bucket: "launch-pad-state-123-us-east-1",
  region: "us-east-1",
  clusterId: "default",
  role: "both",
};

const bundleUrl = "https://example.s3.amazonaws.com/nodes/node-prod-1/agent.cjs?sig=abc";

describe("renderUserData", () => {
  const script = renderUserData({ agent, bundleUrl });

  it("is a bash script", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("embeds the agent config including cluster + role", () => {
    expect(script).toContain('"nodeId": "node-prod-1"');
    expect(script).toContain('"bucket": "launch-pad-state-123-us-east-1"');
    expect(script).toContain('"clusterId": "default"');
    expect(script).toContain('"role": "both"');
  });

  it("installs docker + node", () => {
    expect(script).toContain("dnf install -y docker");
    expect(script).toContain("nodejs");
  });

  it("downloads the agent bundle and starts it", () => {
    expect(script).toContain("agent.cjs?sig=abc");
    expect(script).toContain("/opt/launch-pad/agent.cjs");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
  });

  it("shell-quotes the agent bundle URL", () => {
    const unsafeUrl = "https://example.s3.amazonaws.com/agent.cjs?x=$(touch /tmp/pwn)&quote='";
    const unsafeScript = renderUserData({ agent, bundleUrl: unsafeUrl });

    expect(unsafeScript).toContain(
      "curl -fsSL 'https://example.s3.amazonaws.com/agent.cjs?x=$(touch /tmp/pwn)&quote='\\''' -o /opt/launch-pad/agent.cjs",
    );
    expect(unsafeScript).not.toContain(`curl -fsSL "${unsafeUrl}"`);
  });

  it("runs Caddy on an edge/both node", () => {
    expect(script).toContain("caddy run --config /etc/launch-pad/caddy-init.json");
    expect(script).toContain("systemctl enable --now caddy");
  });

  it("omits Caddy on an app node", () => {
    const appScript = renderUserData({ agent: { ...agent, role: "app" }, bundleUrl });
    expect(appScript).not.toContain("systemctl enable --now caddy");
    expect(appScript).not.toContain("caddyserver.com");
    // but the agent still installs
    expect(appScript).toContain("systemctl enable --now launch-pad-agent");
  });

  it("installs the CloudWatch Agent with the node's system base config", () => {
    expect(script).toContain("dnf install -y amazon-cloudwatch-agent");
    expect(script).toContain("/opt/aws/amazon-cloudwatch-agent/etc/launch-pad-base.json");
    expect(script).toContain("amazon-cloudwatch-agent-ctl -a fetch-config");
    expect(script).toContain("/etc/launch-pad/cw-agent-containers.json");
    // base config targets this node's system log group
    expect(script).toContain('"/launch-pad/default/system/node-prod-1"');
    // edge/both ship caddy too
    expect(script).toContain("launch-pad-logforward-caddy.service");
    expect(script).toContain("launch-pad-logforward-agent.service");
  });

  it("ships only the agent forwarder on an app node (no caddy)", () => {
    const appScript = renderUserData({ agent: { ...agent, role: "app" }, bundleUrl });
    expect(appScript).toContain("dnf install -y amazon-cloudwatch-agent");
    expect(appScript).toContain("launch-pad-logforward-agent.service");
    expect(appScript).not.toContain("launch-pad-logforward-caddy.service");
  });
});

describe("renderSystemdUnit", () => {
  it("restarts always, waits for docker, and runs the bundle via node", () => {
    const unit = renderSystemdUnit();
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("After=docker.service");
    expect(unit).toContain("ExecStart=/usr/bin/env node /opt/launch-pad/agent.cjs");
  });
});
