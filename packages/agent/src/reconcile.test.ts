import { describe, expect, it } from "vitest";
import {
  type DesiredState,
  PROTOCOL_VERSION,
  type ServiceConfig,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import type { ManagedReplica } from "./docker";
import { type Action, planReconcile } from "./reconcile";

function svc(project: string, service: string, image: string, replicas = 1): ServiceConfig {
  return {
    project,
    service,
    image,
    cpu: 256,
    memory: 256,
    replicas,
    env: {},
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
  };
}

function desired(services: ServiceConfig[]): DesiredState {
  return { version: PROTOCOL_VERSION, nodeId: "n1", updatedAt: "now", services };
}

function rep(
  project: string,
  service: string,
  index: number,
  image: string,
  state: string,
  cpu = 256,
  memory = 256,
): ManagedReplica {
  return {
    id: `id-${service}-${index}`,
    name: `launchpad_${project}_${service}_${index}`,
    index,
    state,
    project,
    service,
    image,
    cpu,
    memory,
    hostPort: 20000 + index,
  };
}

function actualMap(reps: ManagedReplica[]): Map<string, ManagedReplica[]> {
  const m = new Map<string, ManagedReplica[]>();
  for (const r of reps) {
    const k = serviceKey(r.project, r.service);
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

function typesFor(actions: Action[], project: string, service: string): string[] {
  return actions
    .filter((a) => "config" in a && a.config.project === project && a.config.service === service)
    .map((a) => a.type);
}

describe("planReconcile (replica-aware)", () => {
  it("creates a missing single replica", () => {
    const actions = planReconcile(desired([svc("blog", "api", "img:1")]), actualMap([]));
    expect(typesFor(actions, "blog", "api")).toEqual(["create"]);
  });

  it("no-ops when the running image matches", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1")]),
      actualMap([rep("blog", "api", 0, "img:1", "running")]),
    );
    expect(typesFor(actions, "blog", "api")).toEqual(["noop"]);
  });

  it("rolls out when the image differs", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:2")]),
      actualMap([rep("blog", "api", 0, "img:1", "running")]),
    );
    expect(typesFor(actions, "blog", "api")).toEqual(["rollout"]);
  });

  it("rolls out when cpu or memory differs (same image)", () => {
    const config = svc("blog", "api", "img:1");
    const cpuActions = planReconcile(
      desired([{ ...config, cpu: 512 }]),
      actualMap([rep("blog", "api", 0, "img:1", "running", 256, 256)]),
    );
    expect(typesFor(cpuActions, "blog", "api")).toEqual(["rollout"]);

    const memActions = planReconcile(
      desired([{ ...config, memory: 512 }]),
      actualMap([rep("blog", "api", 0, "img:1", "running", 256, 256)]),
    );
    expect(typesFor(memActions, "blog", "api")).toEqual(["rollout"]);
  });

  it("starts a matching-but-stopped replica", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1")]),
      actualMap([rep("blog", "api", 0, "img:1", "exited")]),
    );
    expect(typesFor(actions, "blog", "api")).toEqual(["start"]);
  });

  it("creates additional replicas when scaling up", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1", 3)]),
      actualMap([rep("blog", "api", 0, "img:1", "running")]),
    );
    expect(actions.filter((a) => a.type === "create")).toHaveLength(2);
  });

  it("scales down the highest indices", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1", 1)]),
      actualMap([
        rep("blog", "api", 0, "img:1", "running"),
        rep("blog", "api", 1, "img:1", "running"),
      ]),
    );
    const sd = actions.find((a) => a.type === "scaleDown");
    expect(sd?.type === "scaleDown" && sd.remove.map((r) => r.index)).toEqual([1]);
  });

  it("removes a service no longer desired", () => {
    const actions = planReconcile(
      desired([]),
      actualMap([rep("blog", "api", 0, "img:1", "running")]),
    );
    expect(actions.find((a) => a.type === "remove")).toBeDefined();
  });

  it("treats non-0..N-1 replica indices as converged (post-rollout)", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1", 2)]),
      actualMap([
        rep("blog", "api", 5, "img:1", "running"),
        rep("blog", "api", 6, "img:1", "running"),
      ]),
    );
    expect(actions.filter((a) => a.type === "create")).toHaveLength(0);
    expect(actions.filter((a) => a.type === "scaleDown")).toHaveLength(0);
    expect(typesFor(actions, "blog", "api")).toEqual(["noop"]);
  });
});
