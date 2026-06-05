import { describe, expect, it } from "vitest";
import type { ServiceDecl } from "@agentsystemlabs/launch-pad-shared";
import { distributeReplicas, planPlacement } from "./placement";

function decl(over: Partial<ServiceDecl>): ServiceDecl {
  return {
    name: "web",
    dockerfile: "./Dockerfile",
    context: ".",
    replicas: 1,
    cpu: 256,
    memory: 256,
    env: {},
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    ...over,
  } as ServiceDecl;
}

describe("planPlacement", () => {
  it("places all replicas on a single node", () => {
    expect(planPlacement(decl({ node: "a", replicas: 2 }))).toEqual([{ nodeId: "a", replicas: 2 }]);
  });

  it("round-robins evenly across nodes", () => {
    expect(planPlacement(decl({ nodes: ["a", "b"], replicas: 4 }))).toEqual([
      { nodeId: "a", replicas: 2 },
      { nodeId: "b", replicas: 2 },
    ]);
  });

  it("gives the remainder to the earlier nodes", () => {
    expect(planPlacement(decl({ nodes: ["a", "b"], replicas: 3 }))).toEqual([
      { nodeId: "a", replicas: 2 },
      { nodeId: "b", replicas: 1 },
    ]);
  });

  it("drops nodes that receive zero replicas", () => {
    expect(planPlacement(decl({ nodes: ["a", "b", "c"], replicas: 1 }))).toEqual([
      { nodeId: "a", replicas: 1 },
    ]);
  });
});

describe("distributeReplicas (cluster auto-placement)", () => {
  it("spreads replicas round-robin across resolved cluster nodes", () => {
    expect(distributeReplicas(["dev-app", "staging-app"], 3)).toEqual([
      { nodeId: "dev-app", replicas: 2 },
      { nodeId: "staging-app", replicas: 1 },
    ]);
  });

  it("returns nothing when the cluster has no app nodes", () => {
    expect(distributeReplicas([], 4)).toEqual([]);
  });
});
