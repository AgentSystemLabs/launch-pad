import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "./systemd-unit";
import { renderUserData } from "./user-data";

describe("renderUserData", () => {
  const script = renderUserData({
    agent: {
      nodeId: "node-prod-1",
      agentId: "agent-node-prod-1",
      bucket: "launch-pad-state-123-us-east-1",
      region: "us-east-1",
    },
    bundleUrl: "https://example.s3.amazonaws.com/nodes/node-prod-1/agent.cjs?sig=abc",
  });

  it("is a bash script", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("embeds the agent config (nodeId, bucket, region)", () => {
    expect(script).toContain('"nodeId": "node-prod-1"');
    expect(script).toContain('"bucket": "launch-pad-state-123-us-east-1"');
    expect(script).toContain('"region": "us-east-1"');
  });

  it("installs docker, node and caddy", () => {
    expect(script).toContain("dnf install -y docker");
    expect(script).toContain("nodejs");
    expect(script).toContain("caddy");
  });

  it("runs Caddy as a systemd service with a permissive admin config", () => {
    expect(script).toContain("/etc/systemd/system/caddy.service");
    expect(script).toContain("/etc/launch-pad/caddy-init.json");
    expect(script).toContain("caddy run --config /etc/launch-pad/caddy-init.json");
    expect(script).toContain("systemctl enable --now caddy");
  });

  it("downloads the agent bundle from the presigned url and starts it", () => {
    expect(script).toContain("agent.cjs?sig=abc");
    expect(script).toContain("/opt/launch-pad/agent.cjs");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
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
