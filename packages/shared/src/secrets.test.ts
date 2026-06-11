import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "./desired";
import {
  findEnvSecretConflicts,
  secretParameterPath,
  secretParameterPrefix,
  secretRefsForService,
  SECRET_KEY_REGEX,
  serviceConfigStamp,
} from "./secrets";
import { parseLaunchPadConfig } from "./config";
import { parseDesiredState } from "./desired";

describe("secret paths", () => {
  it("builds cluster-scoped SSM paths", () => {
    expect(
      secretParameterPrefix({ clusterId: "lower", ownerProject: "my-app-staging", service: "api" }),
    ).toBe("/launch-pad/lower/my-app-staging/api");
    expect(
      secretParameterPath({
        clusterId: "default",
        ownerProject: "my-app",
        service: "api",
        key: "DATABASE_URL",
      }),
    ).toBe("/launch-pad/default/my-app/api/DATABASE_URL");
  });
});

describe("SECRET_KEY_REGEX", () => {
  it("accepts env-var style names", () => {
    expect(SECRET_KEY_REGEX.test("DATABASE_URL")).toBe(true);
    expect(SECRET_KEY_REGEX.test("STRIPE_KEY")).toBe(true);
  });

  it("rejects lowercase or invalid starters", () => {
    expect(SECRET_KEY_REGEX.test("database_url")).toBe(false);
    expect(SECRET_KEY_REGEX.test("1BAD")).toBe(false);
  });
});

describe("findEnvSecretConflicts", () => {
  it("returns overlapping keys", () => {
    expect(findEnvSecretConflicts({ NODE_ENV: "prod", FOO: "x" }, ["DATABASE_URL", "FOO"])).toEqual([
      "FOO",
    ]);
  });
});

describe("secretRefsForService", () => {
  it("maps key names to full SSM paths", () => {
    expect(
      secretRefsForService(["DATABASE_URL"], {
        clusterId: "default",
        ownerProject: "app",
        service: "web",
      }),
    ).toEqual([{ name: "DATABASE_URL", ssm: "/launch-pad/default/app/web/DATABASE_URL" }]);
  });
});

describe("serviceConfigStamp", () => {
  it("is stable for identical config", () => {
    const cfg: ServiceConfig = {
      project: "p",
      service: "api",
      image: "img:1",
      cpu: 512,
      memory: 512,
      replicas: 1,
      env: { NODE_ENV: "production" },
      secretRefs: [{ name: "DATABASE_URL", ssm: "/launch-pad/default/p/api/DATABASE_URL" }],
      restartAt: "2026-06-09T00:00:00.000Z",
      ingress: null,
      healthCheck: null,
      rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
      volumes: [],
    };
    expect(serviceConfigStamp(cfg)).toBe(serviceConfigStamp({ ...cfg }));
  });

  it("changes when restartAt changes", () => {
    const base: ServiceConfig = {
      project: "p",
      service: "api",
      image: "img:1",
      cpu: 512,
      memory: 512,
      replicas: 1,
      env: {},
      secretRefs: [],
      ingress: null,
      healthCheck: null,
      rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
      volumes: [],
    };
    expect(serviceConfigStamp(base)).not.toBe(
      serviceConfigStamp({ ...base, restartAt: "2026-06-09T00:00:00.000Z" }),
    );
  });

  it("is independent of secret ref order and never includes secret values", () => {
    const base: ServiceConfig = {
      project: "p",
      service: "api",
      image: "img:1",
      cpu: 512,
      memory: 512,
      replicas: 1,
      env: {},
      secretRefs: [
        { name: "STRIPE_SECRET_KEY", ssm: "/launch-pad/default/p/api/STRIPE_SECRET_KEY" },
        { name: "DATABASE_URL", ssm: "/launch-pad/default/p/api/DATABASE_URL" },
      ],
      ingress: null,
      healthCheck: null,
      rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
      volumes: [],
    };

    const reversed = { ...base, secretRefs: [...base.secretRefs].reverse() };
    const stamp = serviceConfigStamp(base);

    expect(stamp).toBe(serviceConfigStamp(reversed));
    expect(stamp).toContain("/launch-pad/default/p/api/DATABASE_URL");
    expect(stamp).not.toContain("postgres://");
  });
});

describe("schema integration", () => {
  it("parses secrets in launch-pad.toml", () => {
    const cfg = parseLaunchPadConfig({
      project: "my-app",
      service: [
        {
          name: "api",
          node: "node-1",
          cpu: 512,
          memory: 512,
          domain: "app.example.com",
          port: 3000,
          healthCheck: { path: "/healthz" },
          secrets: ["DATABASE_URL"],
        },
      ],
    });
    expect(cfg.service[0]?.secrets).toEqual(["DATABASE_URL"]);
  });

  it("parses secretRefs in desired.json with defaults", () => {
    const state = parseDesiredState({
      version: 1,
      nodeId: "n1",
      updatedAt: "now",
      services: [
        {
          project: "p",
          service: "api",
          image: "img:1",
          cpu: 512,
          memory: 512,
          env: {},
          ingress: null,
        },
      ],
    });
    expect(state.services[0]?.secretRefs).toEqual([]);
  });
});
