import { describe, expect, it } from "vitest";
import { nodeFrontsIngress, nodeHostsContainers } from "./node-role";

describe("node role helpers", () => {
  it("nodeHostsContainers is true for app and legacy both", () => {
    expect(nodeHostsContainers("app")).toBe(true);
    expect(nodeHostsContainers("both")).toBe(true);
    expect(nodeHostsContainers("edge")).toBe(false);
  });

  it("nodeFrontsIngress is true for edge and legacy both", () => {
    expect(nodeFrontsIngress("edge")).toBe(true);
    expect(nodeFrontsIngress("both")).toBe(true);
    expect(nodeFrontsIngress("app")).toBe(false);
  });
});
