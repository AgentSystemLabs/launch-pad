import { describe, expect, it } from "vitest";
import { parseLaunchPadConfig } from "./config";
import {
  baselineFromDeployedFootprints,
  findConfigLockViolations,
  snapshotConfigBaseline,
} from "./config-lock";
import { parseDesiredState } from "./desired";
import { parseNodeStatus } from "./status";
import { PROTOCOL_VERSION } from "./constants";

const cronService = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "nightly",
  cron: "0 3 * * *",
  cpu: 256,
  memory: 256,
  ...over,
});

const config = (service: Record<string, unknown>): Record<string, unknown> => ({
  project: "demo",
  service: [service],
});

describe("ServiceDecl cron field", () => {
  it("accepts a worker with a valid cron expression", () => {
    const cfg = parseLaunchPadConfig(config(cronService()));
    expect(cfg.service[0]?.cron).toBe("0 3 * * *");
  });

  it("rejects an invalid cron expression with the field error", () => {
    expect(() => parseLaunchPadConfig(config(cronService({ cron: "61 * * * *" })))).toThrow(/minute/);
    expect(() => parseLaunchPadConfig(config(cronService({ cron: "* * * *" })))).toThrow(/5 fields/);
  });

  it("rejects cron on a web service (domain/port)", () => {
    expect(() =>
      parseLaunchPadConfig(
        config(
          cronService({
            domain: "x.example.com",
            port: 3000,
            healthCheck: { path: "/health" },
          }),
        ),
      ),
    ).toThrow(/cron.*worker|worker.*cron/i);
  });

  it("rejects cron with a healthCheck (runs are gated by exit code, not probes)", () => {
    expect(() =>
      parseLaunchPadConfig(config(cronService({ healthCheck: { path: "/health" } }))),
    ).toThrow(/healthCheck/);
  });

  it("rejects a syntactically-valid expression that can never fire (Feb 30)", () => {
    expect(() => parseLaunchPadConfig(config(cronService({ cron: "0 0 30 2 *" })))).toThrow(/never fires/);
  });

  it("rejects cron with replicas > 1 (one run per fire)", () => {
    expect(() => parseLaunchPadConfig(config(cronService({ replicas: 2 })))).toThrow(/replicas/);
  });

  it("still accepts a plain worker without cron", () => {
    const cfg = parseLaunchPadConfig(config({ name: "w", cpu: 256, memory: 256 }));
    expect(cfg.service[0]?.cron).toBeUndefined();
  });
});

describe("desired.json cron field", () => {
  const base = {
    version: PROTOCOL_VERSION,
    nodeId: "n1",
    updatedAt: "2026-06-11T00:00:00Z",
    services: [
      {
        project: "demo",
        service: "nightly",
        image: "img:abc",
        cpu: 256,
        memory: 256,
        ingress: null,
      },
    ],
  };

  it("parses without cron (back-compat) and with cron (additive)", () => {
    expect(parseDesiredState(base).services[0]?.cron).toBeUndefined();
    const withCron = {
      ...base,
      services: [{ ...base.services[0], cron: "*/5 * * * *" }],
    };
    expect(parseDesiredState(withCron).services[0]?.cron).toBe("*/5 * * * *");
  });
});

describe("status.json cron rollup", () => {
  const svc = {
    project: "demo",
    service: "nightly",
    image: "img:abc",
    state: "running",
    updatedAt: "2026-06-11T00:00:00Z",
  };
  const status = (service: Record<string, unknown>): Record<string, unknown> => ({
    nodeId: "n1",
    agentId: "a1",
    lastSeen: "2026-06-11T00:00:00Z",
    agentVersion: "1.0.0",
    services: [service],
    caddy: { managed: false, lastReloadAt: null, error: null },
  });

  it("parses without cron (back-compat) and with the cron rollup (additive)", () => {
    expect(parseNodeStatus(status(svc)).services[0]?.cron).toBeUndefined();
    const parsed = parseNodeStatus(
      status({
        ...svc,
        cron: {
          lastRunAt: "2026-06-11T03:00:00Z",
          lastExitCode: 0,
          nextRunAt: "2026-06-12T03:00:00Z",
        },
      }),
    );
    expect(parsed.services[0]?.cron?.lastExitCode).toBe(0);
  });
});

describe("config lock covers cron", () => {
  it("changing the cron expression after the first deploy trips the lock", () => {
    const before = parseLaunchPadConfig(config(cronService()));
    const after = parseLaunchPadConfig(config(cronService({ cron: "0 4 * * *" })));
    const baseline = snapshotConfigBaseline(before, "2026-06-11T00:00:00Z");
    const current = snapshotConfigBaseline(after, "2026-06-11T00:00:00Z");
    const violations = findConfigLockViolations(baseline, current);
    expect(violations.map((v) => v.path)).toEqual(["service.nightly"]);
  });

  it("an unchanged cron config compares clean", () => {
    const cfg = parseLaunchPadConfig(config(cronService()));
    const a = snapshotConfigBaseline(cfg, "t1");
    const b = snapshotConfigBaseline(cfg, "t2");
    expect(findConfigLockViolations(a, b)).toEqual([]);
  });

  it("a baseline reconstructed from desired.json carries cron and catches a change", () => {
    const baseline = baselineFromDeployedFootprints(
      { project: "demo" },
      [
        {
          service: "nightly",
          nodeIds: ["n1"],
          replicas: 1,
          cpu: 256,
          memory: 256,
          env: {},
          ingress: null,
          healthCheck: null,
          rollout: { maxSurge: 1, drainTimeout: "10s", stopGrace: "30s" },
          secrets: [],
          volumes: [],
          cron: "0 3 * * *",
        },
      ],
      "2026-06-11T00:00:00Z",
    );
    const current = snapshotConfigBaseline(
      parseLaunchPadConfig(config(cronService({ cron: "0 4 * * *" }))),
      "t",
    );
    const violations = findConfigLockViolations(baseline, current, { baselineFromDesired: true });
    expect(violations.map((v) => v.path)).toEqual(["service.nightly"]);
  });
});
