import { describe, expect, it } from "vitest";
import { parseStatsLine } from "@agentsystemlabs/launch-pad-shared";
import { renderStatsSampleScript } from "./stats-script";

describe("renderStatsSampleScript", () => {
  const script = renderStatsSampleScript("node-prod-1");

  it("runs under bash and embeds the node id", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("NODE_ID='node-prod-1'");
  });

  it("samples host CPU and memory from /proc", () => {
    expect(script).toContain("/proc/stat");
    expect(script).toContain("/proc/meminfo");
  });

  it("samples only managed containers and emits the stats event shape", () => {
    expect(script).toContain("label=launchpad.managed=true");
    expect(script).toContain("docker stats --no-stream --no-trunc");
    expect(script).toContain('"event":"launchpad.stats"');
    expect(script).toContain('launchpad.project');
  });

  it("is deterministic", () => {
    expect(renderStatsSampleScript("node-prod-1")).toBe(script);
  });

  it("rejects a node id that could break out of the single-quoted assignment", () => {
    expect(() => renderStatsSampleScript("a'; rm -rf /")).toThrow(/unsafe node id/);
  });

  it("the emitted printf shape parses as a stats line", () => {
    // Mirror what the script's final printf produces, to lock the JSON contract.
    const emitted = `{"event":"launchpad.stats","nodeId":"node-prod-1","ts":"2026-06-04T00:00:00Z","host":{"cpuPercent":12.5,"memoryUsedMb":900,"memoryTotalMb":2000},"services":[{"project":"blog","service":"api","replica":0,"cpuPercent":40.0,"memoryUsedMb":100,"memoryLimitMb":256}]}`;
    const parsed = parseStatsLine(emitted);
    expect(parsed?.nodeId).toBe("node-prod-1");
    expect(parsed?.services[0]?.service).toBe("api");
  });
});
