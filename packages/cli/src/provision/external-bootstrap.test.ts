import { describe, expect, it } from "vitest";
import { AGENT_ENV_FILE, renderExternalBootstrap, renderExternalCredentialsUpdate } from "./external-bootstrap";
import { renderSystemdUnit } from "./systemd-unit";

const AWS = {
  accessKeyId: "AKIAEXAMPLE0000",
  secretAccessKey: "s3cr3t-do-not-leak-xyz",
  region: "us-east-1",
};

const agentConfigJson = JSON.stringify(
  {
    nodeId: "byos-1",
    agentId: "agent-byos-1",
    bucket: "launch-pad-state-123-us-east-1",
    region: "us-east-1",
    clusterId: "default",
    role: "app",
    advertiseIp: "203.0.113.7",
  },
  null,
  2,
);

const baseParams = {
  agentConfigJson,
  agentBinaryUrl: "https://example.s3.amazonaws.com/nodes/byos-1/agent?sig=abc",
  systemdUnit: renderSystemdUnit("app", { environmentFile: AGENT_ENV_FILE }),
  aws: AWS,
};

describe("renderExternalBootstrap (app role)", () => {
  const script = renderExternalBootstrap({ role: "app", ...baseParams });

  it("is a bash script with strict mode and no xtrace", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).not.toContain("set -x");
    expect(script).not.toContain("set -eux");
  });

  it("detects dnf AND apt-get, fails closed otherwise", () => {
    expect(script).toContain("command -v dnf");
    expect(script).toContain("command -v apt-get");
    expect(script).toContain("exit 1");
    expect(script).toContain("unsupported host");
  });

  it("installs docker for the app role", () => {
    expect(script).toContain("$PKG_INSTALL docker");
    expect(script).toContain("systemctl enable --now docker");
  });

  it("creates the launchpad dirs", () => {
    expect(script).toContain("mkdir -p /etc/launch-pad /opt/launch-pad /var/lib/launch-pad /var/log/launch-pad");
  });

  it("writes agent.env (chmod 600) with all three AWS_ vars", () => {
    expect(script).toContain(`chmod 600 ${AGENT_ENV_FILE}`);
    expect(script).toContain(`AWS_ACCESS_KEY_ID=${AWS.accessKeyId}`);
    expect(script).toContain(`AWS_SECRET_ACCESS_KEY=${AWS.secretAccessKey}`);
    expect(script).toContain(`AWS_REGION=${AWS.region}`);
  });

  it("writes agent.json via a heredoc (chmod 600)", () => {
    expect(script).toContain("cat > /etc/launch-pad/agent.json <<'AGENTCONF'");
    expect(script).toContain("chmod 600 /etc/launch-pad/agent.json");
    expect(script).toContain("AGENTCONF");
  });

  it("includes the advertiseIp from the passed agentConfigJson", () => {
    expect(script).toContain("\"advertiseIp\": \"203.0.113.7\"");
  });

  it("curls the binary url to /opt/launch-pad/agent and chmods it", () => {
    expect(script).toContain(`curl -fsSL "${baseParams.agentBinaryUrl}" -o /opt/launch-pad/agent`);
    expect(script).toContain("chmod 755 /opt/launch-pad/agent");
  });

  it("writes and enables the systemd unit", () => {
    expect(script).toContain(
      "cat > /etc/systemd/system/launch-pad-agent.service <<'UNIT'",
    );
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
  });

  it("forwards the agent journal to a file for direct log shipping", () => {
    expect(script).toContain("cat > /etc/systemd/system/launch-pad-logforward-agent.service");
    expect(script).toContain("journalctl -n 0 -f -u launch-pad-agent.service -o cat");
    expect(script).toContain("StandardOutput=append:/var/log/launch-pad/agent.log");
    expect(script).toContain("systemctl enable --now launch-pad-logforward-agent");
  });

  it("never leaks the secret beyond agent.env", () => {
    // The secret must appear EXACTLY once — only on the AWS_SECRET_ACCESS_KEY line
    // inside the agent.env heredoc. No echo / log / argv inlining elsewhere.
    const occurrences = script.split(AWS.secretAccessKey).length - 1;
    expect(occurrences).toBe(1);
    expect(script).toContain(`AWS_SECRET_ACCESS_KEY=${AWS.secretAccessKey}`);
    expect(script).not.toContain(`echo ${AWS.secretAccessKey}`);
  });
});

describe("renderExternalBootstrap (edge role)", () => {
  const script = renderExternalBootstrap({
    role: "edge",
    ...baseParams,
    systemdUnit: renderSystemdUnit("edge", { environmentFile: AGENT_ENV_FILE }),
  });

  it("does NOT install docker on the edge", () => {
    expect(script).not.toContain("$PKG_INSTALL docker");
    expect(script).not.toContain("systemctl enable --now docker");
  });

  it("installs and starts Caddy on the edge", () => {
    expect(script).toContain('curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64"');
    expect(script).toContain("caddy run --config /etc/launch-pad/caddy-init.json");
    expect(script).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(script).toContain("systemctl enable --now caddy");
  });

  it("still writes credentials, binary, and unit", () => {
    expect(script).toContain(`AWS_ACCESS_KEY_ID=${AWS.accessKeyId}`);
    expect(script).toContain("curl -fsSL");
    expect(script).toContain("systemctl enable --now launch-pad-agent");
  });

  it("forwards caddy logs for an external edge role", () => {
    expect(script).toContain("launch-pad-logforward-caddy.service");
    expect(script).toContain("journalctl -n 0 -f -u caddy.service -o cat");
    expect(script).toContain("StandardOutput=append:/var/log/launch-pad/caddy.log");
  });
});

describe("renderExternalCredentialsUpdate", () => {
  const script = renderExternalCredentialsUpdate({ aws: AWS });

  it("rewrites agent.env with chmod 600 and restarts the agent", () => {
    expect(script).toContain(`touch ${AGENT_ENV_FILE}`);
    expect(script).toContain(`chmod 600 ${AGENT_ENV_FILE}`);
    expect(script).toContain(`AWS_ACCESS_KEY_ID=${AWS.accessKeyId}`);
    expect(script).toContain(`AWS_SECRET_ACCESS_KEY=${AWS.secretAccessKey}`);
    expect(script).toContain("systemctl restart launch-pad-agent");
    expect(script).toContain("systemctl is-active --quiet launch-pad-agent");
  });

  it("does not leak the new secret outside agent.env", () => {
    expect(script.split(AWS.secretAccessKey).length - 1).toBe(1);
    expect(script).not.toContain(`echo ${AWS.secretAccessKey}`);
  });
});
