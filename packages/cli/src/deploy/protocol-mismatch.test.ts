import { describe, expect, it } from "vitest";
import type { NodeStatus } from "@agentsystemlabs/launch-pad-shared";
import { detectProtocolMismatch, protocolMismatchHint } from "./protocol-mismatch";

function status(error: string | null): NodeStatus {
  return {
    nodeId: "whale",
    agentId: "agent-whale",
    agentVersion: "0.0.0",
    lastSeen: new Date().toISOString(),
    caddy: { managed: false, lastReloadAt: null, error },
    edgeRoutes: [],
    services: [],
  };
}

describe("detectProtocolMismatch", () => {
  it("detects the agent heartbeat error from a protocol skew", () => {
    const m = detectProtocolMismatch(
      "whale-drifts-loudly",
      status("unsupported desired.json version 3 (expected 2)"),
    );
    expect(m).toEqual({
      nodeId: "whale-drifts-loudly",
      publishedVersion: 3,
      agentExpectedVersion: 2,
      message: "unsupported desired.json version 3 (expected 2)",
    });
  });

  it("returns null when there is no caddy error", () => {
    expect(detectProtocolMismatch("n1", status(null))).toBeNull();
    expect(detectProtocolMismatch("n1", null)).toBeNull();
  });

  it("ignores unrelated agent errors", () => {
    expect(detectProtocolMismatch("n1", status("docker pull failed: timeout"))).toBeNull();
  });
});

describe("protocolMismatchHint", () => {
  it("points the operator at upgrade-agent", () => {
    const hint = protocolMismatchHint({
      nodeId: "whale-drifts-loudly",
      publishedVersion: 3,
      agentExpectedVersion: 2,
      message: "unsupported desired.json version 3 (expected 2)",
    });
    expect(hint).toContain("whale-drifts-loudly");
    expect(hint).toContain("v3");
    expect(hint).toContain("v2");
    expect(hint).toContain("launchpad node upgrade-agent --yes");
  });
});
