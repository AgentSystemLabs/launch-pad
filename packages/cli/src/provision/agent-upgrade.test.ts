import { describe, expect, it } from "vitest";
import { renderRemoteUpgradeScript, ssmRunBashScript } from "./agent-upgrade";
import { manualUpgradeHint, sshTargetFromHost } from "./upgrade-agent";

describe("renderRemoteUpgradeScript", () => {
  it("downloads the binary, rewrites the unit, and restarts the agent", () => {
    const script = renderRemoteUpgradeScript("https://example.com/agent?sig=a&b=c", "app");
    expect(script).toContain("curl -fsSL 'https://example.com/agent?sig=a&b=c'");
    // Staged via mktemp (not a fixed /tmp path a local process could pre-create).
    expect(script).toContain('staged="$(mktemp)"');
    expect(script).toContain('sudo install -m 755 "$staged" /opt/launch-pad/agent');
    // Migration from the TypeScript agent: the unit must be REWRITTEN (the old one
    // ran `node agent.cjs`) and the stale bundle removed.
    expect(script).toContain("tee /etc/systemd/system/launch-pad-agent.service");
    expect(script).toContain("ExecStart=/opt/launch-pad/agent");
    expect(script).toContain("rm -f /opt/launch-pad/agent.cjs");
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain("systemctl restart launch-pad-agent");
  });

  it("keeps the docker dependency on an app node and never disables docker", () => {
    const script = renderRemoteUpgradeScript("https://example.com/agent", "app");
    expect(script).toContain("After=docker.service");
    expect(script).not.toContain("disable --now docker");
  });

  it("disables docker on an edge node and drops the docker unit dependency", () => {
    const script = renderRemoteUpgradeScript("https://example.com/agent", "edge");
    expect(script).toContain("systemctl disable --now docker");
    expect(script).not.toContain("After=docker.service");
  });

  it("escapes single quotes in presigned URLs", () => {
    const script = renderRemoteUpgradeScript("https://x.example/binary'file", "app");
    expect(script).toContain("'https://x.example/binary'\\''file'");
  });
});

describe("ssmRunBashScript", () => {
  it("wraps the script as a base64 bash one-liner", () => {
    const lines = ssmRunBashScript("#!/bin/bash\necho hi\n");
    const line = lines[0] ?? "";
    expect(line).toMatch(/^echo .+ \| base64 -d \| bash$/);
    const encoded = line.replace("echo ", "").replace(" | base64 -d | bash", "");
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("#!/bin/bash\necho hi\n");
  });
});

describe("external upgrade helpers", () => {
  it("builds an SSH target from the same host shape as node init", () => {
    expect(sshTargetFromHost("ubuntu@203.0.113.5", 2222, "~/.ssh/id_ed25519")).toEqual({
      user: "ubuntu",
      host: "203.0.113.5",
      port: 2222,
      key: "~/.ssh/id_ed25519",
    });
  });

  it("prints an external-node manual fallback that points back to SSH upgrade", () => {
    const hint = manualUpgradeHint("byos-app", "https://example.com/agent", 900, "external");

    expect(hint).toContain("byos-app:");
    expect(hint).toContain("curl -fsSL 'https://example.com/agent'");
    expect(hint).toContain("re-run `launchpad node upgrade-agent <name> --host <user@host> --ssh-key <path>`");
    expect(hint).toContain("Presigned URL valid for ~15 min");
  });

  it("escapes single quotes in manual upgrade hint URLs", () => {
    const hint = manualUpgradeHint("byos-app", "https://example.com/agent'file", 900, "external");

    expect(hint).toContain("curl -fsSL 'https://example.com/agent'\\''file'");
  });
});
