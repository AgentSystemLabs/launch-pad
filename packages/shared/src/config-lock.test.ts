import { describe, expect, it } from "vitest";
import {
  assertConfigLockAllowed,
  baselineFromDeployedFootprints,
  findConfigLockViolations,
  parseConfigBaseline,
  snapshotConfigBaseline,
  type ConfigBaseline,
  type DeployedFootprint,
} from "./config-lock";
import { type LaunchPadConfig } from "./config";
import { LAUNCH_PAD_ENVIRONMENT } from "./constants";

const baseConfig: LaunchPadConfig = {
  project: "edge-express-web",
  service: [
    {
      name: "web",
      dockerfile: "./Dockerfile",
      context: ".",
      replicas: 1,
      cpu: 256,
      memory: 256,
      env: { NODE_ENV: "production" },
      domain: "app.agentsystem.dev",
      port: 3000,
      healthCheck: { path: "/healthz", intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 },
      rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
      secrets: [],
      volumes: [],
    },
  ],
};

function withService(overrides: Partial<LaunchPadConfig["service"][number]>): LaunchPadConfig {
  return { ...baseConfig, service: [{ ...baseConfig.service[0]!, ...overrides }] };
}

function baseline(config = baseConfig): ConfigBaseline {
  return snapshotConfigBaseline(config, "2026-06-04T00:00:00.000Z");
}

/** A desired.json-shaped footprint for "web", as deploy publishes it. */
const webFootprint: DeployedFootprint = {
  service: "web",
  nodeIds: ["node-app"],
  replicas: 1,
  cpu: 256,
  memory: 256,
  env: { NODE_ENV: "production" },
  secrets: [],
  // ingress + healthCheck carry the RESOLVED port, exactly like desired.json.
  ingress: { domain: "app.agentsystem.dev", port: 3000, edge: "node-edge" },
  healthCheck: { path: "/healthz", port: 3000, intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 },
  rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
  volumes: [],
};

describe("snapshotConfigBaseline", () => {
  it("sorts services by name", () => {
    const snap = snapshotConfigBaseline(
      {
        project: "p",
        service: [
          { ...baseConfig.service[0]!, name: "z", cpu: 256, memory: 256 },
          { ...baseConfig.service[0]!, name: "a", cpu: 256, memory: 256, domain: undefined, port: undefined, healthCheck: undefined },
        ],
      },
      "now",
    );
    expect(snap.services.map((s) => s.name)).toEqual(["a", "z"]);
  });

  it("resolves healthCheck.port to the service port so it matches the deployed form", () => {
    const snap = baseline();
    expect(snap.services[0]?.healthCheck?.port).toBe(3000);
  });

  it("does not emit the removed placement fields (node/nodes/edge/topology)", () => {
    const snap = baseline();
    expect(snap.services[0]).not.toHaveProperty("node");
    expect(snap.services[0]).not.toHaveProperty("nodes");
    expect(snap.services[0]).not.toHaveProperty("edge");
    expect(snap.services[0]).not.toHaveProperty("topology");
  });
});

describe("findConfigLockViolations (baseline file)", () => {
  it("allows cpu and memory changes only", () => {
    const current = baseline(withService({ cpu: 512, memory: 1024 }));
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
    expect(() => assertConfigLockAllowed(baseline(), current)).not.toThrow();
  });

  it("allows adding secret key names after the initial deploy", () => {
    const current = baseline(withService({ secrets: ["DATABASE_URL", "STRIPE_KEY"] }));
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
  });

  it("rejects project rename", () => {
    const current = baseline({ ...baseConfig, project: "other" });
    expect(findConfigLockViolations(baseline(), current)).toEqual([
      expect.objectContaining({ path: "project" }),
    ]);
  });

  it("rejects a component change (added, removed, or renamed)", () => {
    const withComponent = baseline({ ...baseConfig, component: "auth" });
    expect(findConfigLockViolations(baseline(), withComponent)).toEqual([
      expect.objectContaining({ path: "component" }),
    ]);
    expect(findConfigLockViolations(withComponent, baseline())).toEqual([
      expect.objectContaining({ path: "component" }),
    ]);
    const renamed = baseline({ ...baseConfig, component: "notes" });
    expect(findConfigLockViolations(withComponent, renamed)).toEqual([
      expect.objectContaining({ path: "component" }),
    ]);
    expect(findConfigLockViolations(withComponent, withComponent)).toEqual([]);
  });

  it("a reconstructed baseline carries the logical identity, not the derived owner", () => {
    const recon = baselineFromDeployedFootprints(
      { project: "edge-express-web", component: "auth" },
      [webFootprint],
      "now",
    );
    expect(recon.project).toBe("edge-express-web");
    expect(recon.component).toBe("auth");
    const current = baseline({ ...baseConfig, component: "auth" });
    expect(findConfigLockViolations(recon, current, { baselineFromDesired: true })).toEqual([]);
  });

  it("allows domain change after the initial deploy", () => {
    const current = baseline(withService({ domain: "other.example.com" }));
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
    expect(() => assertConfigLockAllowed(baseline(), current)).not.toThrow();
  });

  it("rejects port change", () => {
    const current = baseline(withService({ port: 8080 }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
  });

  it("allows replicas changes (scaling is a safe post-deploy mutation)", () => {
    const current = baseline(withService({ replicas: 3 }));
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
    expect(() => assertConfigLockAllowed(baseline(), current)).not.toThrow();
  });

  it("allows cpu, memory, replicas, env, and secrets to all change together", () => {
    const current = baseline(
      withService({
        cpu: 512,
        memory: 1024,
        replicas: 4,
        env: { NODE_ENV: "staging", FEATURE_X: "on" },
        secrets: ["DATABASE_URL"],
      }),
    );
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
    expect(() => assertConfigLockAllowed(baseline(), current)).not.toThrow();
  });

  it("rejects dockerfile / context change", () => {
    expect(findConfigLockViolations(baseline(), baseline(withService({ dockerfile: "./Other.Dockerfile" })))[0]?.path).toBe("service.web");
    expect(findConfigLockViolations(baseline(), baseline(withService({ context: "./app" })))[0]?.path).toBe("service.web");
  });

  it("rejects healthCheck change", () => {
    const current = baseline(
      withService({ healthCheck: { path: "/ready", intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 } }),
    );
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
  });

  it("rejects rollout change", () => {
    const current = baseline(withService({ rollout: { maxSurge: 2, drainTimeout: "20s", stopGrace: "30s" } }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
  });

  it("allows env changes (non-secret config is a safe post-deploy mutation)", () => {
    expect(findConfigLockViolations(baseline(), baseline(withService({ env: { NODE_ENV: "staging" } })))).toEqual([]);
    expect(
      findConfigLockViolations(baseline(), baseline(withService({ env: { NODE_ENV: "production", FEATURE_X: "on" } }))),
    ).toEqual([]);
  });

  it("parses a legacy baseline carrying the removed placement fields and compares clean", () => {
    // Baselines written before the placement model was removed may still carry
    // node/nodes/edge/schedule/topology — they parse, but are stripped from the
    // lock view, so they never trip the lock against a fresh snapshot.
    const legacy = JSON.parse(JSON.stringify(baseline())) as ConfigBaseline;
    legacy.services[0]!.node = "node-app";
    legacy.services[0]!.edge = "node-edge";
    legacy.services[0]!.topology = "auto";
    legacy.services[0]!.schedule = "even";
    const reparsed = parseConfigBaseline(legacy);
    expect(reparsed.services[0]?.node).toBe("node-app");
    expect(reparsed.services[0]?.schedule).toBe("even");
    expect(findConfigLockViolations(reparsed, baseline())).toEqual([]);
    expect(findConfigLockViolations(baseline(), reparsed)).toEqual([]);
  });

  it("ignores a legacy `nodes` list in a stored baseline", () => {
    const legacy = JSON.parse(JSON.stringify(baseline())) as ConfigBaseline;
    legacy.services[0]!.nodes = ["node-a", "node-b"];
    expect(findConfigLockViolations(parseConfigBaseline(legacy), baseline())).toEqual([]);
  });

  it("allows top-level domainPattern change", () => {
    const before = baseline({ ...baseConfig, domainPattern: "{service}.example.com" });
    const after = baseline({ ...baseConfig, domainPattern: "{service}-{env}.example.com" });
    expect(findConfigLockViolations(before, after)).toEqual([]);
  });

  it("allows per-service domainPattern change", () => {
    const current = baseline(withService({ domainPattern: "api-{env}.example.com" }));
    expect(findConfigLockViolations(baseline(), current)).toEqual([]);
  });

  it("rejects added or removed services", () => {
    const added = baseline({
      ...baseConfig,
      service: [
        baseConfig.service[0]!,
        { ...baseConfig.service[0]!, name: "worker", domain: undefined, port: undefined, healthCheck: undefined },
      ],
    });
    expect(findConfigLockViolations(baseline(), added).some((v) => v.path === "service.worker")).toBe(true);

    const removed = baseline();
    const current = { ...removed, services: [] };
    expect(findConfigLockViolations(removed, current).some((v) => v.path === "service.web")).toBe(true);
  });

  it("rejects a service rename (removed + added)", () => {
    const renamed = baseline(withService({ name: "webgg" }));
    const violations = findConfigLockViolations(baseline(), renamed);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "service.web" }),
        expect.objectContaining({ path: "service.webgg" }),
      ]),
    );
    expect(() => assertConfigLockAllowed(baseline(), renamed)).toThrow(
      /only cpu, memory, replicas, env, secrets, domain, and domainPattern may change/,
    );
  });
});

describe("findConfigLockViolations (baseline reconstructed from desired.json)", () => {
  const fromDesired = baselineFromDeployedFootprints({ project: "edge-express-web" }, [webFootprint], "now");
  const opts = { baselineFromDesired: true } as const;

  it("allows a cpu/memory-only change (no false positive on dockerfile/context/healthCheck port)", () => {
    const current = baseline(withService({ cpu: 512, memory: 1024 }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
    expect(() => assertConfigLockAllowed(fromDesired, current, opts)).not.toThrow();
  });

  it("allows an unchanged config", () => {
    expect(findConfigLockViolations(fromDesired, baseline(), opts)).toEqual([]);
  });

  it("does not emit placement fields when reconstructing from footprints", () => {
    expect(fromDesired.services[0]).not.toHaveProperty("node");
    expect(fromDesired.services[0]).not.toHaveProperty("nodes");
    expect(fromDesired.services[0]).not.toHaveProperty("edge");
    expect(fromDesired.services[0]).not.toHaveProperty("topology");
  });

  it("rejects a service rename", () => {
    const renamed = baseline(withService({ name: "webgg" }));
    expect(() => assertConfigLockAllowed(fromDesired, renamed, opts)).toThrow(/service "web" was removed/);
  });

  it("allows a domain change", () => {
    const current = baseline(withService({ domain: "other.example.com" }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("allows an env change", () => {
    const current = baseline(withService({ env: { NODE_ENV: "staging" } }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("allows a replicas change", () => {
    const current = baseline(withService({ replicas: 5 }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("ignores the deploy-injected LAUNCH_PAD_ENVIRONMENT in a reconstructed env", () => {
    const envFootprint: DeployedFootprint = {
      ...webFootprint,
      env: { [LAUNCH_PAD_ENVIRONMENT]: "staging", NODE_ENV: "production" },
    };
    const recon = baselineFromDeployedFootprints({ project: "edge-express-web" }, [envFootprint], "now");
    // current TOML declares only NODE_ENV — the injected var must not look like a change.
    expect(findConfigLockViolations(recon, baseline(), opts)).toEqual([]);
  });
});

describe("config lock — persistent volumes are locked identity", () => {
  const withVol = (volumes: Array<{ name: string; path: string }>): LaunchPadConfig => ({
    project: "edge-express-web",
    service: [
      {
        name: "web",
        dockerfile: "./Dockerfile",
        context: ".",
        replicas: 1,
        cpu: 256,
        memory: 256,
        env: { NODE_ENV: "production" },
        domain: "app.agentsystem.dev",
        port: 3000,
        healthCheck: { path: "/healthz", intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 },
        rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
        secrets: [],
        volumes,
      },
    ],
  });

  it("allows an unchanged volume set", () => {
    const base = snapshotConfigBaseline(withVol([{ name: "data", path: "/data" }]), "t");
    const cur = snapshotConfigBaseline(withVol([{ name: "data", path: "/data" }]), "t2");
    expect(findConfigLockViolations(base, cur)).toEqual([]);
  });

  it("rejects adding, removing, or changing a volume after the first deploy", () => {
    const base = snapshotConfigBaseline(withVol([{ name: "data", path: "/data" }]), "t");
    const added = snapshotConfigBaseline(
      withVol([{ name: "data", path: "/data" }, { name: "cache", path: "/cache" }]),
      "t2",
    );
    const movedPath = snapshotConfigBaseline(withVol([{ name: "data", path: "/var/data" }]), "t2");
    const removed = snapshotConfigBaseline(withVol([]), "t2");
    for (const cur of [added, movedPath, removed]) {
      const v = findConfigLockViolations(base, cur);
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]!.path).toContain("web");
    }
  });

  it("compares equal to a baseline reconstructed from desired.json (volumes carried on the wire)", () => {
    const base = snapshotConfigBaseline(withVol([{ name: "data", path: "/data" }]), "t");
    const reconstructed = baselineFromDeployedFootprints(
      { project: "edge-express-web" },
      [{ ...webFootprint, volumes: [{ name: "data", path: "/data" }] }],
      "t2",
    );
    expect(findConfigLockViolations(base, reconstructed, { baselineFromDesired: true })).toEqual([]);
  });
});
