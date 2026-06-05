import { describe, expect, it } from "vitest";
import {
  assertConfigLockAllowed,
  baselineFromDeployedFootprints,
  findConfigLockViolations,
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
  // ingress + healthCheck carry the RESOLVED port, exactly like desired.json.
  ingress: { domain: "app.agentsystem.dev", port: 3000, edge: "node-edge" },
  healthCheck: { path: "/healthz", port: 3000, intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 },
  rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
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

  it("rejects replicas change", () => {
    const current = baseline(withService({ replicas: 3 }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
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

  it("rejects env and placement changes", () => {
    expect(findConfigLockViolations(baseline(), baseline(withService({ env: { NODE_ENV: "staging" } })))[0]?.path).toBe("service.web");
    expect(findConfigLockViolations(baseline(), baseline(withService({ node: "node-app-2" })))[0]?.path).toBe("service.web");
    expect(findConfigLockViolations(baseline(), baseline(withService({ node: undefined, nodes: ["a", "b"], edge: "node-edge" })))[0]?.path).toBe("service.web");
  });

  it("rejects edge change", () => {
    const current = baseline(withService({ edge: "node-edge-2" }));
    expect(findConfigLockViolations(baseline(), current)[0]?.path).toBe("service.web");
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
    expect(() => assertConfigLockAllowed(baseline(), renamed)).toThrow(/only cpu and memory may change/);
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

  it("rejects an env change", () => {
    const current = baseline(withService({ env: { NODE_ENV: "staging" } }));
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
