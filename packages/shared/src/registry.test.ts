import { describe, expect, it } from "vitest";
import { nodeUsesElasticIp } from "./registry";

describe("nodeUsesElasticIp", () => {
  it("edge nodes get a stable public IP", () => {
    expect(nodeUsesElasticIp("edge")).toBe(true);
  });

  it("legacy both nodes get a stable public IP", () => {
    expect(nodeUsesElasticIp("both")).toBe(true);
  });

  it("app nodes are VPC-private only", () => {
    expect(nodeUsesElasticIp("app")).toBe(false);
  });
});
