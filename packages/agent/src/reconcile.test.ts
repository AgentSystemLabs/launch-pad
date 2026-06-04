import { describe, expect, it } from "vitest";
import {
  type DesiredState,
  PROTOCOL_VERSION,
  type ServiceConfig,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import type { ManagedContainer } from "./docker";
import { type Action, planReconcile } from "./reconcile";

function svc(project: string, service: string, image: string): ServiceConfig {
  return { project, service, image, cpu: 256, memory: 256, env: {}, ingress: null };
}

function desired(services: ServiceConfig[]): DesiredState {
  return { version: PROTOCOL_VERSION, nodeId: "n1", updatedAt: "now", services };
}

function container(
  project: string,
  service: string,
  image: string,
  state: string,
): ManagedContainer {
  return { id: `id-${service}`, name: `launchpad_${project}_${service}`, state, project, service, image };
}

function actualMap(containers: ManagedContainer[]): Map<string, ManagedContainer> {
  return new Map(containers.map((c) => [serviceKey(c.project, c.service), c]));
}

function typeFor(actions: Action[], project: string, service: string): string | undefined {
  return actions.find((a) => "config" in a && a.config.project === project && a.config.service === service)
    ?.type;
}

describe("planReconcile", () => {
  it("creates a service that has no container", () => {
    const actions = planReconcile(desired([svc("blog", "api", "img:1")]), actualMap([]));
    expect(typeFor(actions, "blog", "api")).toBe("create");
  });

  it("no-ops when the running image matches", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1")]),
      actualMap([container("blog", "api", "img:1", "running")]),
    );
    expect(typeFor(actions, "blog", "api")).toBe("noop");
  });

  it("replaces when the image differs", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:2")]),
      actualMap([container("blog", "api", "img:1", "running")]),
    );
    expect(typeFor(actions, "blog", "api")).toBe("replace");
  });

  it("starts a matching-but-stopped container", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1")]),
      actualMap([container("blog", "api", "img:1", "exited")]),
    );
    expect(typeFor(actions, "blog", "api")).toBe("start");
  });

  it("removes a managed container no longer desired", () => {
    const actions = planReconcile(
      desired([]),
      actualMap([container("blog", "api", "img:1", "running")]),
    );
    const remove = actions.find((a) => a.type === "remove");
    expect(remove).toMatchObject({ type: "remove", name: "launchpad_blog_api" });
  });

  it("leaves another project's containers untouched while creating its own", () => {
    const actions = planReconcile(
      desired([svc("blog", "api", "img:1")]),
      actualMap([container("shop", "web", "img:9", "running")]),
    );
    // blog/api created, shop/web removed (not in desired) — both decisions present
    expect(typeFor(actions, "blog", "api")).toBe("create");
    expect(actions.some((a) => a.type === "remove" && a.name === "launchpad_shop_web")).toBe(true);
  });
});
