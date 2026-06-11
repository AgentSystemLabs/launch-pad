import { describe, expect, it } from "vitest";
import {
  clusterConfigKey,
  clusterNodesPrefix,
  configBaselineKey,
  deployEventKey,
  deployEventsPrefix,
  desiredKey,
  ecrRepositoryName,
  edgeUpstreamKey,
  edgeUpstreamPrefix,
  nodePrefix,
  nodeRegistryKey,
  stateBucketName,
  statusKey,
} from "./s3-keys";

describe("s3 key derivation", () => {
  it("derives an account+region scoped bucket name", () => {
    expect(stateBucketName("493255580566", "us-east-1")).toBe(
      "launch-pad-state-493255580566-us-east-1",
    );
  });

  it("derives node-scoped keys for the default cluster at the legacy root", () => {
    expect(nodePrefix("default", "node-prod-1")).toBe("nodes/node-prod-1/");
    expect(nodeRegistryKey("default", "node-prod-1")).toBe("nodes/node-prod-1/node.json");
    expect(desiredKey("default", "node-prod-1")).toBe("nodes/node-prod-1/desired.json");
    expect(statusKey("default", "node-prod-1")).toBe("nodes/node-prod-1/status.json");
  });

  it("scopes a named cluster's nodes under clusters/<id>/nodes/", () => {
    expect(clusterNodesPrefix("lower")).toBe("clusters/lower/nodes/");
    expect(nodePrefix("lower", "dev-app")).toBe("clusters/lower/nodes/dev-app/");
    expect(nodeRegistryKey("lower", "dev-app")).toBe("clusters/lower/nodes/dev-app/node.json");
    expect(desiredKey("lower", "dev-app")).toBe("clusters/lower/nodes/dev-app/desired.json");
    expect(clusterConfigKey("lower")).toBe("clusters/lower/cluster.json");
  });

  it("derives an ECR repo name from project + service", () => {
    expect(ecrRepositoryName("my-app", "web")).toBe("my-app/web");
  });

  it("derives a per-footprint config baseline key", () => {
    expect(configBaselineKey("default", "edge-express-web")).toBe(
      "projects/edge-express-web/config-baseline.json",
    );
    expect(configBaselineKey("lower", "edge-express-web-staging")).toBe(
      "clusters/lower/projects/edge-express-web-staging/config-baseline.json",
    );
  });

  it("derives per-footprint deploy-event keys (timestamp-leading for chronological listing)", () => {
    expect(deployEventsPrefix("default", "shop")).toBe("projects/shop/events/");
    expect(deployEventsPrefix("lower", "shop-staging")).toBe(
      "clusters/lower/projects/shop-staging/events/",
    );
    expect(deployEventKey("default", "shop", "2026-06-10T12:00:00.000Z", "ab12")).toBe(
      "projects/shop/events/2026-06-10T12:00:00.000Z-ab12.json",
    );
  });

  it("derives edge upstream shard keys under the edge node prefix", () => {
    expect(edgeUpstreamPrefix("default", "edge-1")).toBe("nodes/edge-1/upstream/");
    expect(edgeUpstreamKey("default", "edge-1", "app-1")).toBe("nodes/edge-1/upstream/app-1.json");
    expect(edgeUpstreamKey("lower", "edge-1", "app-1")).toBe(
      "clusters/lower/nodes/edge-1/upstream/app-1.json",
    );
  });
});
