import { describe, expect, it } from "vitest";
import { renderRemoteUpgradeScript, ssmRunBashScript } from "./agent-upgrade";

describe("renderRemoteUpgradeScript", () => {
  it("downloads the bundle and restarts the agent", () => {
    const script = renderRemoteUpgradeScript("https://example.com/agent.cjs?sig=a&b=c");
    expect(script).toContain("curl -fsSL 'https://example.com/agent.cjs?sig=a&b=c'");
    expect(script).toContain("sudo install -m 755 /tmp/launch-pad-agent.cjs /opt/launch-pad/agent.cjs");
    expect(script).toContain("systemctl restart launch-pad-agent");
  });

  it("downloads a Rust binary to the Rust install path", () => {
    const script = renderRemoteUpgradeScript("https://example.com/agent?sig=a&b=c", "rust");
    expect(script).toContain("curl -fsSL 'https://example.com/agent?sig=a&b=c' -o /tmp/launch-pad-agent");
    expect(script).toContain("sudo install -m 755 /tmp/launch-pad-agent /opt/launch-pad/agent");
    expect(script).toContain("systemctl restart launch-pad-agent");
  });

  it("escapes single quotes in presigned URLs", () => {
    const script = renderRemoteUpgradeScript("https://x.example/bundle'file");
    expect(script).toContain("'https://x.example/bundle'\\''file'");
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
