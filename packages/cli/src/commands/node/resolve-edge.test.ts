import { describe, expect, it } from "vitest";
import { CliError } from "../../errors";
import { planEdgeForAppNode } from "./resolve-edge";

describe("planEdgeForAppNode", () => {
  it("prefers an explicit --edge over everything else", () => {
    expect(
      planEdgeForAppNode({
        clusterId: "default",
        explicitEdge: "edge-explicit",
        defaultEdge: "edge-default",
        edgeRoleNodeIds: ["edge-a", "edge-b"],
      }),
    ).toBe("edge-explicit");
  });

  it("falls back to the cluster's default edge when no --edge is given", () => {
    expect(
      planEdgeForAppNode({
        clusterId: "prod",
        defaultEdge: "edge-default",
        edgeRoleNodeIds: ["edge-a", "edge-b"],
      }),
    ).toBe("edge-default");
  });

  it("auto-attaches to the cluster's single edge-role node with no flag or default", () => {
    expect(
      planEdgeForAppNode({
        clusterId: "default",
        edgeRoleNodeIds: ["edge-1"],
      }),
    ).toBe("edge-1");
  });

  it("auto-attaches even on the default cluster (no cluster.json defaultEdge)", () => {
    expect(
      planEdgeForAppNode({
        clusterId: "default",
        explicitEdge: undefined,
        defaultEdge: null,
        edgeRoleNodeIds: ["edge-1"],
      }),
    ).toBe("edge-1");
  });

  it("errors when no edge exists yet", () => {
    expect(() =>
      planEdgeForAppNode({ clusterId: "default", edgeRoleNodeIds: [] }),
    ).toThrow(CliError);
    expect(() =>
      planEdgeForAppNode({ clusterId: "default", edgeRoleNodeIds: [] }),
    ).toThrow(/needs an edge/);
  });

  it("errors ambiguously when multiple edges exist and no default is set", () => {
    let caught: unknown;
    try {
      planEdgeForAppNode({
        clusterId: "prod",
        edgeRoleNodeIds: ["edge-a", "edge-b"],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain("2 edge nodes");
    expect((caught as CliError).message).toContain("edge-a, edge-b");
    expect((caught as { hint?: string }).hint).toContain("set-edge");
  });

  it("a default edge resolves an otherwise-ambiguous multi-edge cluster", () => {
    expect(
      planEdgeForAppNode({
        clusterId: "prod",
        defaultEdge: "edge-b",
        edgeRoleNodeIds: ["edge-a", "edge-b"],
      }),
    ).toBe("edge-b");
  });
});
