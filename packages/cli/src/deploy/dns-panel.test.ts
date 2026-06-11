import { describe, expect, it } from "vitest";
import { buildDnsChecklist, type DnsTarget } from "./dns-panel";

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
    expect(lines.some((l) => /grey cloud/i.test(l))).toBe(true);
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
});
