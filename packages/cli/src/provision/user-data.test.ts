import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell-quote";
import { renderSystemdUnit } from "./systemd-unit";
import { type AgentConfig, renderUserData } from "./user-data";

const edgeAgent: AgentConfig = {
  nodeId: "node-prod-1",
  agentId: "agent-node-prod-1",
  bucket: "launch-pad-state-123-us-east-1",
  region: "us-east-1",
  clusterId: "default",
  role: "edge",
};

const appAgent: AgentConfig = { ...edgeAgent, role: "app" };

const agentBinaryUrl = "https://example.s3.amazonaws.com/nodes/node-prod-1/agent?sig=abc";

describe("renderUserData (edge)", () => {
  const script = renderUserData({ agent: edgeAgent, architecture: "x86_64", agentBinaryUrl });

  it("is a bash script with strict mode and no xtrace", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toMatch(/set\s+-[a-z]*x/);
  });

  it("embeds the agent config including cluster + role", () => {
    expect(script).toContain('"nodeId": "node-prod-1"');
    expect(script).toContain('"bucket": "launch-pad-state-123-us-east-1"');
    expect(script).toContain('"clusterId": "default"');
    expect(script).toContain('"role": "edge"');
  });

  it("never installs Docker or Node.js on an edge node", () => {
    expect(script).not.toContain("dnf install -y docker");
    expect(script).not.toContain("systemctl enable --now docker");
    expect(script).not.toContain("nodejs");
    expect(script).not.toContain("rpm.nodesource.com");
  });

  it("downloads the agent binary, makes it executable, and starts it", () => {
    expect(script).toContain("agent?sig=abc");
    expect(script).toContain("-o /opt/launch-pad/agent");
    expect(script).toContain("chmod +x /opt/launch-pad/agent");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
  });

  it("shell-quotes the binary url before embedding it in user data", () => {
    const hostileUrl = "https://example.com/agent?sig='$(touch /tmp/pwn)'";
    const hostileScript = renderUserData({ agent: edgeAgent, architecture: "x86_64", agentBinaryUrl: hostileUrl });

    expect(hostileScript).toContain(`curl -fsSL ${shellQuote(hostileUrl)} -o /opt/launch-pad/agent`);
    expect(hostileScript).not.toContain(`curl -fsSL "${hostileUrl}"`);
  });

  it("runs Caddy on an edge node", () => {
    expect(script).toContain("caddy run --config /etc/launch-pad/caddy-init.json");
    expect(script).toContain("systemctl enable --now caddy");
  });

  it("downloads the ARM Caddy binary for an ARM edge", () => {
    const arm = renderUserData({ agent: edgeAgent, architecture: "arm64", agentBinaryUrl });
    expect(arm).toContain("arch=arm64");
  });

  it("installs the CloudWatch Agent with the node's system base config", () => {
    expect(script).toContain("dnf install -y amazon-cloudwatch-agent");
    expect(script).toContain("/opt/aws/amazon-cloudwatch-agent/etc/launch-pad-base.json");
    expect(script).toContain("amazon-cloudwatch-agent-ctl -a fetch-config");
    // base config targets this node's system log group
    expect(script).toContain('"/launch-pad/default/system/node-prod-1"');
    // the edge ships caddy too
    expect(script).toContain("launch-pad-logforward-caddy.service");
    expect(script).toContain("launch-pad-logforward-agent.service");
  });
});

describe("renderUserData (app)", () => {
  const script = renderUserData({ agent: appAgent, architecture: "x86_64", agentBinaryUrl });

  it("installs Docker but never Caddy or Node.js", () => {
    expect(script).toContain("dnf install -y docker");
    expect(script).toContain("systemctl enable --now docker");
    expect(script).not.toContain("caddyserver.com");
    expect(script).not.toContain("systemctl enable --now caddy");
    expect(script).not.toContain("nodejs");
    expect(script).not.toContain("rpm.nodesource.com");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
  });

  it("ships only the agent forwarder (no caddy)", () => {
    expect(script).toContain("launch-pad-logforward-agent.service");
    expect(script).not.toContain("launch-pad-logforward-caddy.service");
  });
});

describe("renderUserData (golden AMI)", () => {
  it("verifies the baked agent binary on an edge without installs or S3 download", () => {
    const golden = renderUserData({ agent: edgeAgent, architecture: "x86_64", bootstrapMode: "golden" });
    expect(golden).toContain("test -x /opt/launch-pad/agent");
    expect(golden).toContain("test -x /usr/local/bin/caddy");
    expect(golden).toContain("test -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl");
    expect(golden).not.toContain("dnf install");
    expect(golden).not.toContain("agent?sig=abc");
    expect(golden).not.toContain("docker");
  });

  it("enables preinstalled docker on a golden app node", () => {
    const golden = renderUserData({ agent: appAgent, architecture: "x86_64", bootstrapMode: "golden" });
    expect(golden).toContain("systemctl enable --now docker");
    expect(golden).not.toContain("dnf install -y docker");
    expect(golden).toContain("test -x /opt/launch-pad/agent");
    expect(golden).not.toContain("caddy run");
  });

  it("requires the binary URL only for full bootstrap", () => {
    expect(() => renderUserData({ agent: appAgent, architecture: "x86_64", bootstrapMode: "full" })).toThrow(
      /agentBinaryUrl is required/,
    );
    expect(() => renderUserData({ agent: appAgent, architecture: "x86_64", bootstrapMode: "golden" })).not.toThrow();
  });
});

describe("renderSystemdUnit", () => {
  it("app unit restarts always, waits for docker, and runs the binary", () => {
    const unit = renderSystemdUnit("app");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("After=docker.service");
    expect(unit).toContain("ExecStart=/opt/launch-pad/agent");
    expect(unit).not.toContain("node ");
  });

  it("edge unit does not depend on docker", () => {
    const unit = renderSystemdUnit("edge");
    expect(unit).not.toContain("docker.service");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("ExecStart=/opt/launch-pad/agent");
  });
});
