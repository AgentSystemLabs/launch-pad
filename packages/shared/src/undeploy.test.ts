import { describe, expect, it } from "vitest";
import { snapshotConfigBaseline } from "./config-lock";
import { parseLaunchPadConfig } from "./config";
import type { ServiceConfig } from "./desired";
import { planUndeploy, removeServicesFromBaseline, servicesAfterRemoval } from "./undeploy";

const OWNER = "shop";

/** A minimal published ServiceConfig for the given project/service on a node. */
function svc(
  project: string,
  service: string,
  patch: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    project,
    service,
    image: `123.dkr.ecr.us-east-1.amazonaws.com/${project}/${service}:sha`,
    cpu: 256,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    ...patch,
  };
}

const webIngress = { domain: "shop.example.com", port: 3000, edge: "node-edge" };

describe("planUndeploy", () => {
  it("removes the whole footprint from every node it occupies (servicesToRemove = null)", () => {
    const states = [
      { nodeId: "node-a", services: [svc(OWNER, "web", { ingress: webIngress }), svc(OWNER, "worker")] },
      { nodeId: "node-b", services: [svc(OWNER, "web", { ingress: webIngress })] },
    ];
    const plan = planUndeploy(states, OWNER, null);

    expect(plan.nodes.map((n) => n.nodeId).sort()).toEqual(["node-a", "node-b"]);
    expect(new Set(plan.removedServices)).toEqual(new Set(["web", "worker"]));
    // Whole footprint gone → nothing kept on any node.
    for (const n of plan.nodes) expect(n.kept).toEqual([]);
    expect(plan.removedDomains).toEqual(["shop.example.com"]);
    expect(plan.affectedEdges).toEqual(["node-edge"]);
  });

  it("never touches another project's services (ownership-scoped)", () => {
    const states = [
      {
        nodeId: "node-a",
        services: [svc(OWNER, "web"), svc("other", "api"), svc("other", "worker")],
      },
    ];
    const plan = planUndeploy(states, OWNER, null);

    expect(plan.removedServices).toEqual(["web"]);
    const node = plan.nodes.find((n) => n.nodeId === "node-a");
    // `kept` is the FULL set of the OWNER's surviving services on this node — none here.
    expect(node?.kept).toEqual([]);
    // The other project's services are simply not part of the plan at all.
    expect(plan.nodes).toHaveLength(1);
  });

  it("partial undeploy keeps the footprint's other services on each node", () => {
    const states = [
      {
        nodeId: "node-a",
        services: [svc(OWNER, "web", { ingress: webIngress }), svc(OWNER, "worker")],
      },
    ];
    const plan = planUndeploy(states, OWNER, ["worker"]);

    expect(plan.removedServices).toEqual(["worker"]);
    const node = plan.nodes.find((n) => n.nodeId === "node-a");
    expect(node?.removed).toEqual(["worker"]);
    expect(node?.kept.map((s) => s.service)).toEqual(["web"]);
    // worker had no ingress → no domains/edges affected.
    expect(plan.removedDomains).toEqual([]);
    expect(plan.affectedEdges).toEqual([]);
  });

  it("only lists nodes that actually host a removed service", () => {
    const states = [
      { nodeId: "node-a", services: [svc(OWNER, "web"), svc(OWNER, "worker")] },
      { nodeId: "node-b", services: [svc(OWNER, "web")] }, // no worker → not affected by a worker-only undeploy
      { nodeId: "node-c", services: [svc("other", "x")] }, // unrelated project
    ];
    const plan = planUndeploy(states, OWNER, ["worker"]);

    expect(plan.nodes.map((n) => n.nodeId)).toEqual(["node-a"]);
  });

  it("does not report a removed domain that a kept replica still fronts", () => {
    // web runs on two nodes; removing it from node-a only must still drop the domain
    // there, but a domain is only 'removed' overall when NO surviving replica fronts it.
    const states = [
      { nodeId: "node-a", services: [svc(OWNER, "web", { ingress: webIngress }), svc(OWNER, "worker")] },
      { nodeId: "node-b", services: [svc(OWNER, "web", { ingress: webIngress })] },
    ];
    // Remove only the worker → web (and its domain) survives everywhere.
    const plan = planUndeploy(states, OWNER, ["worker"]);
    expect(plan.removedDomains).toEqual([]);
    expect(plan.affectedEdges).toEqual([]);
  });

  it("reports a domain as removed when the last replica fronting it goes away", () => {
    const states = [
      { nodeId: "node-a", services: [svc(OWNER, "web", { ingress: webIngress })] },
      { nodeId: "node-b", services: [svc(OWNER, "worker")] },
    ];
    const plan = planUndeploy(states, OWNER, ["web"]);
    expect(plan.removedDomains).toEqual(["shop.example.com"]);
    expect(plan.affectedEdges).toEqual(["node-edge"]);
  });

  it("returns an empty plan when nothing is deployed for the footprint", () => {
    const states = [{ nodeId: "node-a", services: [svc("other", "x")] }];
    const plan = planUndeploy(states, OWNER, null);
    expect(plan.nodes).toEqual([]);
    expect(plan.removedServices).toEqual([]);
  });

  it("returns an empty plan when the named service is not deployed", () => {
    const states = [{ nodeId: "node-a", services: [svc(OWNER, "web")] }];
    const plan = planUndeploy(states, OWNER, ["worker"]);
    expect(plan.nodes).toEqual([]);
    expect(plan.removedServices).toEqual([]);
  });
});

describe("servicesAfterRemoval", () => {
  it("drops the whole footprint (removeSet = null) but keeps other projects", () => {
    const existing = [svc(OWNER, "web"), svc(OWNER, "worker"), svc("other", "api")];
    const next = servicesAfterRemoval(existing, OWNER, null);
    expect(next.map((s) => `${s.project}/${s.service}`)).toEqual(["other/api"]);
  });

  it("drops only the named services for the footprint", () => {
    const existing = [svc(OWNER, "web"), svc(OWNER, "worker"), svc("other", "worker")];
    const next = servicesAfterRemoval(existing, OWNER, new Set(["worker"]));
    expect(next.map((s) => `${s.project}/${s.service}`)).toEqual(["shop/web", "other/worker"]);
  });

  it("is a no-op for an empty remove set", () => {
    const existing = [svc(OWNER, "web")];
    expect(servicesAfterRemoval(existing, OWNER, new Set())).toEqual(existing);
  });
});

describe("removeServicesFromBaseline", () => {
  const config = () =>
    parseLaunchPadConfig({
      project: OWNER,
      service: [
        {
          name: "web",
          node: "node-a",
          dockerfile: "./Dockerfile",
          context: ".",
          cpu: 256,
          memory: 256,
          domain: "shop.example.com",
          port: 3000,
          healthCheck: { path: "/healthz" },
        },
        { name: "worker", node: "node-a", dockerfile: "./Dockerfile", context: ".", cpu: 256, memory: 256 },
      ],
    });

  it("drops the named service and keeps the rest", () => {
    const baseline = snapshotConfigBaseline(config(), "now");
    const next = removeServicesFromBaseline(baseline, ["worker"]);
    expect(next).not.toBeNull();
    expect(next?.services.map((s) => s.name)).toEqual(["web"]);
    // version/project preserved.
    expect(next?.project).toBe(OWNER);
    expect(next?.version).toBe(baseline.version);
  });

  it("returns null when the last service is removed (caller deletes the baseline file)", () => {
    const baseline = snapshotConfigBaseline(config(), "now");
    expect(removeServicesFromBaseline(baseline, ["web", "worker"])).toBeNull();
  });

  it("is a no-op (returns an equal baseline) when removing nothing", () => {
    const baseline = snapshotConfigBaseline(config(), "now");
    const next = removeServicesFromBaseline(baseline, []);
    expect(next?.services.map((s) => s.name)).toEqual(["web", "worker"]);
  });

  it("ignores service names that aren't in the baseline", () => {
    const baseline = snapshotConfigBaseline(config(), "now");
    const next = removeServicesFromBaseline(baseline, ["ghost"]);
    expect(next?.services.map((s) => s.name)).toEqual(["web", "worker"]);
  });
});
