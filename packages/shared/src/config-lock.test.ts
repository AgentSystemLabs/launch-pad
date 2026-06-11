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
      node: "node-app",
      edge: "node-edge",
      schedule: "even",
      topology: "auto",
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
          { ...baseConfig.service[0]!, name: "a", cpu: 256, memory: 256, domain: undefined, port: undefined, edge: undefined, healthCheck: undefined },
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

  it("rejects domain change before anything else", () => {
    const current = baseline(withService({ domain: "other.example.com" }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
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

  it("rejects placement changes", () => {
    expect(findConfigLockViolations(baseline(), baseline(withService({ node: "node-app-2" })))[0]?.path).toBe("service.web");
    expect(findConfigLockViolations(baseline(), baseline(withService({ node: undefined, nodes: ["a", "b"], edge: "node-edge" })))[0]?.path).toBe("service.web");
  });

  it("rejects edge change", () => {
    const current = baseline(withService({ edge: "node-edge-2" }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
  });

  it("rejects schedule and topology changes", () => {
    expect(findConfigLockViolations(baseline(), baseline(withService({ schedule: "capacity" })))[0]?.path).toBe("service.web");
    expect(findConfigLockViolations(baseline(), baseline(withService({ topology: "split" })))[0]?.path).toBe("service.web");
  });

  it("parses a legacy baseline without schedule/topology and compares clean", () => {
    // A baseline file written before the fields existed: strip them, re-parse, compare.
    const legacy = JSON.parse(JSON.stringify(baseline())) as ConfigBaseline;
    for (const s of legacy.services) {
      delete (s as Partial<(typeof legacy.services)[number]>).schedule;
      delete (s as Partial<(typeof legacy.services)[number]>).topology;
    }
    const reparsed = parseConfigBaseline(legacy);
    expect(reparsed.services[0]?.schedule).toBe("even");
    expect(reparsed.services[0]?.topology).toBe("auto");
    expect(findConfigLockViolations(reparsed, baseline())).toEqual([]);
  });

  it("rejects top-level domainPattern change", () => {
    const before = baseline({ ...baseConfig, domainPattern: "{service}.example.com" });
    const after = baseline({ ...baseConfig, domainPattern: "{service}.other.com" });
    expect(findConfigLockViolations(before, after)).toEqual([
      expect.objectContaining({ path: "domainPattern" }),
    ]);
  });

  it("rejects added or removed services", () => {
    const added = baseline({
      ...baseConfig,
      service: [
        baseConfig.service[0]!,
        { ...baseConfig.service[0]!, name: "worker", domain: undefined, port: undefined, edge: undefined, healthCheck: undefined },
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
      /only cpu, memory, replicas, env, and secrets may change/,
    );
  });
});

describe("findConfigLockViolations (baseline reconstructed from desired.json)", () => {
  const fromDesired = baselineFromDeployedFootprints("edge-express-web", [webFootprint], "now");
  const opts = { baselineFromDesired: true } as const;

  it("allows a cpu/memory-only change (no false positive on dockerfile/context/healthCheck port)", () => {
    const current = baseline(withService({ cpu: 512, memory: 1024 }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
    expect(() => assertConfigLockAllowed(fromDesired, current, opts)).not.toThrow();
  });

  it("allows an unchanged config", () => {
    expect(findConfigLockViolations(fromDesired, baseline(), opts)).toEqual([]);
  });

  it("rejects a service rename", () => {
    const renamed = baseline(withService({ name: "webgg" }));
    expect(() => assertConfigLockAllowed(fromDesired, renamed, opts)).toThrow(/service "web" was removed/);
  });

  it("rejects a domain change", () => {
    const current = baseline(withService({ domain: "other.example.com" }));
    expect(findConfigLockViolations(fromDesired, current, opts)[0]?.path).toBe("service.web");
  });

  it("allows an env change", () => {
    const current = baseline(withService({ env: { NODE_ENV: "staging" } }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("allows a replicas change", () => {
    const current = baseline(withService({ replicas: 5 }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("drops schedule/topology from the compare (desired.json can't carry them)", () => {
    const current = baseline(withService({ schedule: "capacity", topology: "split" }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("does not false-positive on a cluster-placed decl vs reconstructed node/nodes/edge", () => {
    // The reconstructed baseline records wherever replicas landed (node-app,
    // edge node-edge); a decl that never pinned placement must not trip the lock.
    const current = baseline(withService({ node: undefined, edge: undefined }));
    expect(findConfigLockViolations(fromDesired, current, opts)).toEqual([]);
  });

  it("still catches a node change on a PINNED decl in fromDesired mode", () => {
    const current = baseline(withService({ node: "node-app-2" }));
    expect(findConfigLockViolations(fromDesired, current, opts)[0]?.path).toBe("service.web");
  });

  it("ignores the deploy-injected LAUNCH_PAD_ENVIRONMENT in a reconstructed env", () => {
    const envFootprint: DeployedFootprint = {
      ...webFootprint,
      env: { [LAUNCH_PAD_ENVIRONMENT]: "staging", NODE_ENV: "production" },
    };
    const recon = baselineFromDeployedFootprints("edge-express-web", [envFootprint], "now");
    // current TOML declares only NODE_ENV — the injected var must not look like a change.
    expect(findConfigLockViolations(recon, baseline(), opts)).toEqual([]);
  });
});

describe("config lock — persistent volumes are locked identity", () => {
  // A volume-bearing service must be pinned, so it carries `node` (no edge/web here).
  const pinnedWithVol = (volumes: Array<{ name: string; path: string }>): LaunchPadConfig => ({
    project: "edge-express-web",
    service: [
      {
        name: "web",
        node: "node-app",
        edge: "node-edge",
        schedule: "even",
        topology: "auto",
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
    const base = snapshotConfigBaseline(pinnedWithVol([{ name: "data", path: "/data" }]), "t");
    const cur = snapshotConfigBaseline(pinnedWithVol([{ name: "data", path: "/data" }]), "t2");
    expect(findConfigLockViolations(base, cur)).toEqual([]);
  });

  it("rejects adding, removing, or changing a volume after the first deploy", () => {
    const base = snapshotConfigBaseline(pinnedWithVol([{ name: "data", path: "/data" }]), "t");
    const added = snapshotConfigBaseline(
      pinnedWithVol([{ name: "data", path: "/data" }, { name: "cache", path: "/cache" }]),
      "t2",
    );
    const movedPath = snapshotConfigBaseline(pinnedWithVol([{ name: "data", path: "/var/data" }]), "t2");
    const removed = snapshotConfigBaseline(pinnedWithVol([]), "t2");
    for (const cur of [added, movedPath, removed]) {
      const v = findConfigLockViolations(base, cur);
      expect(v.length).toBeGreaterThan(0);
      expect(v[0]!.path).toContain("web");
    }
  });

  it("compares equal to a baseline reconstructed from desired.json (volumes carried on the wire)", () => {
    const base = snapshotConfigBaseline(pinnedWithVol([{ name: "data", path: "/data" }]), "t");
    const reconstructed = baselineFromDeployedFootprints(
      "edge-express-web",
      [{ ...webFootprint, volumes: [{ name: "data", path: "/data" }] }],
      "t2",
    );
    expect(findConfigLockViolations(base, reconstructed, { baselineFromDesired: true })).toEqual([]);
  });
});
