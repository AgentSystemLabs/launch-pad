import { describe, expect, it } from "vitest";
import { buildDnsChecklist, type DnsTarget, HIDDEN_EIP, wildcardForPattern } from "./dns-panel";

describe("buildDnsChecklist", () => {
  it("returns [] when there are no web domains", () => {
    expect(buildDnsChecklist([])).toEqual([]);
  });

  it("maps each domain to its fronting node's Elastic IP", () => {
    const targets: DnsTarget[] = [
      { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: "54.210.10.20" },
      { domain: "api.example.com", frontingNode: "node-app-1", viaEdge: false, eip: "54.210.10.21" },
    ];
    const lines = buildDnsChecklist(targets);
    expect(lines[0]).toContain("app.example.com");
    expect(lines[0]).toContain("54.210.10.20");
    expect(lines[0]).toContain("edge node-edge");
    expect(lines[1]).toContain("api.example.com");
    expect(lines[1]).toContain("54.210.10.21");
    expect(lines[1]).toContain("node node-app-1");
    expect(lines.some((l) => /dns verify/.test(l))).toBe(true);
    expect(lines.some((l) => /resolve directly to the edge IP/i.test(l))).toBe(true);
  });

  it("calls out a domain whose node has no public IP yet", () => {
    const lines = buildDnsChecklist([
      { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: null },
    ]);
    expect(lines[0]).toContain("no public IP yet");
    expect(lines[0]).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("de-duplicates a domain served by more than one entry", () => {
    const targets: DnsTarget[] = [
      { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: "1.2.3.4" },
      { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: "1.2.3.4" },
    ];
    const lines = buildDnsChecklist(targets);
    expect(lines.filter((l) => l.includes("app.example.com"))).toHaveLength(1);
  });

  it("adds a wildcard hint when given one and an EIP is known", () => {
    const lines = buildDnsChecklist(
      [{ domain: "app-pr-1.example.com", frontingNode: "node-edge", viaEdge: true, eip: "1.2.3.4" }],
      "*.example.com",
    );
    expect(lines.some((l) => l.includes("*.example.com") && l.includes("1.2.3.4"))).toBe(true);
  });

  it("omits the wildcard hint when no node has an EIP yet", () => {
    const lines = buildDnsChecklist(
      [{ domain: "app-pr-1.example.com", frontingNode: "node-edge", viaEdge: true, eip: null }],
      "*.example.com",
    );
    expect(lines.some((l) => l.includes("*.example.com"))).toBe(false);
  });

  it("masks the edge IP everywhere when hideIp is set, and explains how to reveal it", () => {
    const lines = buildDnsChecklist(
      [
        { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: "54.210.10.20" },
        { domain: "app-pr-1.example.com", frontingNode: "node-edge", viaEdge: true, eip: "54.210.10.20" },
      ],
      "*.example.com",
      { hideIp: true },
    );
    // No real IP-looking token survives anywhere in the rendered panel.
    for (const line of lines) expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(lines.some((l) => l.includes(HIDDEN_EIP))).toBe(true);
    // The wildcard row is masked too (it would otherwise re-expose the IP).
    expect(lines.some((l) => l.includes("*.example.com") && l.includes(HIDDEN_EIP))).toBe(true);
    expect(lines.some((l) => /hidden in this log/i.test(l))).toBe(true);
  });

  it("still shows the real IP when hideIp is false/absent (default)", () => {
    const target: DnsTarget = { domain: "app.example.com", frontingNode: "node-edge", viaEdge: true, eip: "54.210.10.20" };
    expect(buildDnsChecklist([target]).some((l) => l.includes("54.210.10.20"))).toBe(true);
    expect(buildDnsChecklist([target], null, { hideIp: false }).some((l) => l.includes("54.210.10.20"))).toBe(true);
  });
});

describe("wildcardForPattern", () => {
  it("derives the wildcard when the pattern varies only its first label", () => {
    expect(wildcardForPattern("{service}-{env}.example.com")).toBe("*.example.com");
    expect(wildcardForPattern("{service}.shop.example.com")).toBe("*.shop.example.com");
  });

  it("returns null when one wildcard label can't cover the projections", () => {
    expect(wildcardForPattern("{service}.{env}.example.com")).toBeNull();
    expect(wildcardForPattern("app-{env}.example.{tld}")).toBeNull();
  });
});
