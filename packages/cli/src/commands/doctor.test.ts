import { describe, expect, it } from "vitest";
import { staleExternalNodeIds } from "./doctor";

const NOW = Date.parse("2026-06-20T00:00:00.000Z");

describe("staleExternalNodeIds", () => {
  it("flags missing and stale heartbeats but not fresh ones", () => {
    expect(
      staleExternalNodeIds(
        [
          { nodeId: "fresh", lastSeen: "2026-06-19T23:59:45.000Z" },
          { nodeId: "stale", lastSeen: "2026-06-19T23:58:00.000Z" },
          { nodeId: "missing", lastSeen: null },
        ],
        NOW,
      ),
    ).toEqual(["stale", "missing"]);
  });
});
