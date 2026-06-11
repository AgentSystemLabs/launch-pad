import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesiredState,
  PROTOCOL_VERSION,
  serviceConfigStamp,
  type ServiceConfig,
  serviceKey,
} from "@agentsystemlabs/launch-pad-shared";
import { type ManagedReplica, stopContainer } from "./docker";
import { waitHealthy } from "./health";
import { type Action, type ApplyContext, applyActions, planReconcile } from "./reconcile";

// The rollout tests below exercise applyActions' ORDERING (routing refresh vs.
// container stop), so Docker and the health probe are stubbed out entirely.
vi.mock("./docker", () => ({
  containerName: (project: string, service: string, index: number) =>
    `launchpad_${project}_${service}_${index}`,
  pull: vi.fn(async () => {}),
  removeContainer: vi.fn(async () => {}),
  runContainer: vi.fn(async () => {}),
  startContainer: vi.fn(async () => {}),
  stopContainer: vi.fn(async () => {}),
}));
vi.mock("./health", () => ({ waitHealthy: vi.fn(async () => true) }));

function svc(project: string, service: string, image: string, replicas = 1): ServiceConfig {
  return {
    project,
    service,
    image,
    cpu: 256,
    memory: 256,
    replicas,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
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
  const cfg = svc(project, service, image);
  cfg.cpu = cpu;
  cfg.memory = memory;
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
    configStamp: serviceConfigStamp(cfg),
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

  it("rolls out when restartAt changes (deploy --restart)", () => {
    const config = { ...svc("blog", "api", "img:1"), restartAt: "2026-06-09T00:00:00.000Z" };
    const actions = planReconcile(
      desired([config]),
      actualMap([rep("blog", "api", 0, "img:1", "running")]),
    );
    expect(typesFor(actions, "blog", "api")).toEqual(["rollout"]);
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

/** A web service fronted by a REMOTE edge node (routing propagates via S3 shards). */
function webSvc(image: string, replicas = 1): ServiceConfig {
  return {
    ...svc("p", "web", image, replicas),
    ingress: { domain: "app.example.com", port: 3000, edge: "edge-1" },
    healthCheck: { path: "/healthz", intervalMs: 100, timeoutMs: 100, healthyThreshold: 1 },
    rollout: { maxSurge: 1, drainTimeout: "0s", stopGrace: "1s" },
  };
}

function makeCtx(overrides: Partial<ApplyContext> = {}): { ctx: ApplyContext; events: string[] } {
  const events: string[] = [];
  let nextPort = 21000;
  const ctx: ApplyContext = {
    bindHost: () => "0.0.0.0",
    port: () => {
      nextPort += 1;
      return nextPort;
    },
    releasePort: () => {},
    refreshRouting: async (excludeIds = new Set()) => {
      events.push(`refresh[${[...excludeIds].sort().join(",")}]`);
    },
    drainFloorMs: () => 0,
    heartbeat: async () => {},
    errors: new Map(),
    ...overrides,
  };
  return { ctx, events };
}

describe("applyActions rollout (remote-edge routing safety)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes a draining replica from routing BEFORE stopping it, flooring the wait at the propagation time", async () => {
    const config = webSvc("img:2");
    const old = rep("p", "web", 0, "img:1", "running");
    const { ctx, events } = makeCtx({ drainFloorMs: () => 80 });
    let excludePublishedAt = 0;
    let stoppedAt = 0;
    const recordRefresh = ctx.refreshRouting;
    ctx.refreshRouting = async (excludeIds = new Set()) => {
      await recordRefresh(excludeIds);
      if (excludeIds.has(old.id) && excludePublishedAt === 0) excludePublishedAt = Date.now();
    };
    vi.mocked(waitHealthy).mockResolvedValue(true);
    vi.mocked(stopContainer).mockImplementation(async (id) => {
      events.push(`stop[${id}]`);
      if (id === old.id) stoppedAt = Date.now();
    });

    await applyActions([{ type: "rollout", config, replicas: [old] }], ctx);

    expect(events).toEqual([
      "refresh[]", // surged replica passed health → joined routing
      `refresh[${old.id}]`, // old replica removed from routing (drain)…
      `stop[${old.id}]`, // …and only stopped after the drain wait
      "refresh[]", // final converged refresh
    ]);
    // drainTimeout is "0s" but the remote-edge floor (80ms here) must still apply.
    expect(stoppedAt - excludePublishedAt).toBeGreaterThanOrEqual(75);
    expect(ctx.errors.size).toBe(0);
  });

  it("aborts on a failed health check: stops only the NEW replica, old keeps serving", async () => {
    const config = webSvc("img:2");
    const old = rep("p", "web", 0, "img:1", "running");
    const { ctx, events } = makeCtx();
    vi.mocked(waitHealthy).mockResolvedValue(false);
    vi.mocked(stopContainer).mockImplementation(async (id) => {
      events.push(`stop[${id}]`);
    });

    await applyActions([{ type: "rollout", config, replicas: [old] }], ctx);

    // The failed surge (index 1) is stopped by name; the old replica is never
    // stopped and the post-abort refresh keeps it routed.
    expect(events).toEqual(["stop[launchpad_p_web_1]", "refresh[]"]);
    expect(ctx.errors.get("p/web")).toMatch(/failed health check/);
  });
});
