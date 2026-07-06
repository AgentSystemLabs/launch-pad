import { describe, expect, it } from "vitest";
import { LAUNCH_PAD_ENVIRONMENT } from "./constants";
import {
  NODE_ID_REGEX,
  nodeIdError,
  componentOwner,
  containerEnvForDeploy,
  envProject,
  footprintOwner,
  isWebService,
  parseLaunchPadConfig,
  resolveServiceDomain,
} from "./config";

const web = {
  name: "web",
  cpu: 512,
  memory: 512,
  domain: "app.example.com",
  port: 3000,
  healthCheck: { path: "/healthz" },
};

const worker = {
  name: "worker",
  cpu: 256,
  memory: 256,
};

describe("NODE_ID_REGEX", () => {
  it("accepts letters, digits, hyphens, and underscores", () => {
    for (const id of ["node-dev-1", "my_app", "yt-example", "Node1", "a"]) {
      expect(NODE_ID_REGEX.test(id)).toBe(true);
      expect(nodeIdError(id)).toBeNull();
    }
  });

  it("rejects empty, spaced, or punctuation-heavy ids", () => {
    for (const id of ["", "-bad", "bad name", "bad.com", "node/app"]) {
      expect(NODE_ID_REGEX.test(id)).toBe(false);
      expect(nodeIdError(id)).not.toBeNull();
    }
  });
});

describe("parseLaunchPadConfig", () => {
  it("parses a valid config and applies defaults", () => {
    const cfg = parseLaunchPadConfig({ project: "my-app", service: [web, worker] });
    expect(cfg.project).toBe("my-app");
    expect(cfg.service[0]?.dockerfile).toBe("./Dockerfile");
    expect(cfg.service[0]?.context).toBe(".");
    expect(cfg.service[0]?.env).toEqual({});
  });

  it("classifies web vs worker", () => {
    const cfg = parseLaunchPadConfig({ project: "my-app", service: [web, worker] });
    expect(isWebService(cfg.service[0]!)).toBe(true);
    expect(isWebService(cfg.service[1]!)).toBe(false);
  });

  it("rejects a domain without a port", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "my-app", service: [{ ...worker, domain: "x.com" }] }),
    ).toThrow(/BOTH `domain` and `port`/);
  });

  it("rejects a port without a domain", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "my-app", service: [{ ...worker, port: 8080 }] }),
    ).toThrow(/BOTH `domain` and `port`/);
  });

  it("rejects duplicate service names", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "my-app", service: [worker, worker] }),
    ).toThrow(/duplicate service name/);
  });

  it("rejects an invalid project label", () => {
    expect(() => parseLaunchPadConfig({ project: "My_App", service: [worker] })).toThrow();
  });

  it("rejects domains that are not hostnames", () => {
    for (const domain of ["*", "https://app.example.com", "app.example.com/path", "app.example.com:443"]) {
      expect(() =>
        parseLaunchPadConfig({ project: "my-app", service: [{ ...web, domain }] }),
      ).toThrow(/domain must be a DNS hostname/);
    }
  });

  it("rejects IPv4 addresses as domains", () => {
    for (const domain of ["192.168.1.1", "10.0.0.1", "1.2.3.4"]) {
      expect(() =>
        parseLaunchPadConfig({ project: "my-app", service: [{ ...web, domain }] }),
      ).toThrow(/domain must be a DNS hostname/);
    }
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "my-app", service: [worker], extra: true }),
    ).toThrow();
  });

  it("parses one-off jobs and applies build/env defaults", () => {
    const cfg = parseLaunchPadConfig({
      project: "my-app",
      service: [web],
      job: [{ name: "migrate", cpu: 256, memory: 128, secrets: ["DATABASE_URL"] }],
    });
    expect(cfg.job?.[0]).toMatchObject({
      name: "migrate",
      dockerfile: "./Dockerfile",
      context: ".",
      env: {},
      secrets: ["DATABASE_URL"],
    });
  });

  it("rejects job names that collide with services, databases, or jobs", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [worker], job: [{ name: "worker", cpu: 1, memory: 1 }] }),
    ).toThrow(/job name.*worker.*collides/);
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [worker],
        database: [{ name: "primary" }],
        job: [{ name: "primary", cpu: 1, memory: 1 }],
      }),
    ).toThrow(/job name.*primary.*collides/);
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [worker],
        job: [{ name: "migrate", cpu: 1, memory: 1 }, { name: "migrate", cpu: 1, memory: 1 }],
      }),
    ).toThrow(/job name.*migrate.*collides/);
  });

  it("rejects unsupported keys inside a job", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [worker],
        job: [{ name: "migrate", cpu: 256, memory: 128, cron: "* * * * *" }],
      }),
    ).toThrow(/job\[0\]\.cron: unsupported key/);
  });
});

describe("component (federated multi-repo deploys)", () => {
  it("accepts an optional component label", () => {
    const cfg = parseLaunchPadConfig({ project: "shop", component: "auth", service: [worker] });
    expect(cfg.component).toBe("auth");
  });

  it("component stays undefined when omitted", () => {
    const cfg = parseLaunchPadConfig({ project: "shop", service: [worker] });
    expect(cfg.component).toBeUndefined();
  });

  it("rejects an invalid component label", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", component: "Auth_X", service: [worker] }),
    ).toThrow();
  });

  it("rejects the reserved `--` separator inside project and component", () => {
    expect(() => parseLaunchPadConfig({ project: "shop--x", service: [worker] })).toThrow(/--/);
    expect(() =>
      parseLaunchPadConfig({ project: "shop", component: "a--b", service: [worker] }),
    ).toThrow(/--/);
  });
});

describe("componentOwner / footprintOwner", () => {
  it("componentOwner without a component is the project itself", () => {
    expect(componentOwner("shop", undefined)).toBe("shop");
  });

  it("componentOwner joins with the reserved separator", () => {
    expect(componentOwner("shop", "auth")).toBe("shop--auth");
  });

  it("footprintOwner composes component and env", () => {
    expect(footprintOwner({ project: "shop" }, undefined)).toBe("shop");
    expect(footprintOwner({ project: "shop" }, "staging")).toBe("shop-staging");
    expect(footprintOwner({ project: "shop", component: "auth" }, undefined)).toBe("shop--auth");
    expect(footprintOwner({ project: "shop", component: "auth" }, "pr-7")).toBe("shop--auth-pr-7");
  });
});

describe("removed / unsupported service keys", () => {
  it("rejects deprecated `cluster` in a service with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, cluster: "lower" }] }),
    ).toThrow(/cluster.*not supported in launch-pad\.toml.*--cluster/);
  });

  it("rejects the removed `node` key with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, node: "node-dev-1" }] }),
    ).toThrow(/service\[0\]\.node: `node` was removed.*placement is automatic/);
  });

  it("rejects the removed `nodes` key with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, nodes: ["a", "b"] }] }),
    ).toThrow(/`nodes` was removed.*placement is automatic/);
  });

  it("rejects the removed `edge` key with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, edge: "edge-1" }] }),
    ).toThrow(/`edge` was removed.*dedicated edge node/);
  });

  it("rejects the removed `topology` key with a migration hint", () => {
    for (const topology of ["split", "co-located", "auto"]) {
      expect(() =>
        parseLaunchPadConfig({ project: "p", service: [{ ...web, topology }] }),
      ).toThrow(/`topology` was removed.*split-topology/);
    }
  });

  it("rejects the removed `schedule` key with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, schedule: "even" }] }),
    ).toThrow(/`schedule` was removed/);
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, schedule: "capacity" }] }),
    ).toThrow(/`schedule` was removed/);
  });

  it("rejects unsupported service keys with a clear path", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, environment: "staging" }] }),
    ).toThrow(/service\[0\]\.environment: unsupported key/);
  });
});

describe("replicas / healthCheck validation", () => {
  it("defaults replicas to 1 and rollout to sane values", () => {
    const cfg = parseLaunchPadConfig({ project: "my-app", service: [web] });
    expect(cfg.service[0]?.replicas).toBe(1);
    expect(cfg.service[0]?.rollout).toEqual({ maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" });
  });

  it("requires a healthCheck for every web service, even replicas = 1", () => {
    // replicas = 1 (the default) still requires it — surge-based rolling runs regardless.
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, healthCheck: undefined }] }),
    ).toThrow(/needs a \[service\.healthCheck\]/);
    // replicas > 1 too.
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, healthCheck: undefined, replicas: 2 }] }),
    ).toThrow(/needs a \[service\.healthCheck\]/);
    // with a healthCheck → ok at any replica count.
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, replicas: 2 }] }),
    ).not.toThrow();
  });

  it("allows worker replicas without a healthCheck", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, replicas: 3 }] }),
    ).not.toThrow();
  });
});

describe("envProject", () => {
  it("returns the base project with no env", () => {
    expect(envProject("my-app", undefined)).toBe("my-app");
  });
  it("suffixes the env for a namespaced footprint", () => {
    expect(envProject("my-app", "staging")).toBe("my-app-staging");
  });
});

describe("containerEnvForDeploy", () => {
  it("passes through declared env on a production deploy", () => {
    expect(containerEnvForDeploy({ NODE_ENV: "production" }, undefined)).toEqual({
      NODE_ENV: "production",
    });
  });

  it("injects LAUNCH_PAD_ENVIRONMENT when --env is set", () => {
    expect(containerEnvForDeploy({ NODE_ENV: "production" }, "preview")).toEqual({
      [LAUNCH_PAD_ENVIRONMENT]: "preview",
      NODE_ENV: "production",
    });
  });

  it("lets a user override LAUNCH_PAD_ENVIRONMENT in the service env block", () => {
    expect(
      containerEnvForDeploy({ [LAUNCH_PAD_ENVIRONMENT]: "custom", NODE_ENV: "production" }, "preview"),
    ).toEqual({
      [LAUNCH_PAD_ENVIRONMENT]: "custom",
      NODE_ENV: "production",
    });
  });
});

describe("resolveServiceDomain", () => {
  it("returns undefined for a worker regardless of env", () => {
    expect(resolveServiceDomain({ service: "worker" }, undefined)).toBeUndefined();
    expect(resolveServiceDomain({ service: "worker" }, "staging")).toBeUndefined();
  });

  it("returns the literal domain when no env is given", () => {
    expect(resolveServiceDomain({ domain: "testing.agentsystem.dev", service: "api" }, undefined)).toBe(
      "testing.agentsystem.dev",
    );
  });

  it("uses the default `-<env>` convention when no pattern is set", () => {
    expect(resolveServiceDomain({ domain: "testing.agentsystem.dev", service: "api" }, "dev")).toBe(
      "testing-dev.agentsystem.dev",
    );
    expect(resolveServiceDomain({ domain: "api.acme.com", service: "api" }, "staging")).toBe(
      "api-staging.acme.com",
    );
  });

  it("interpolates {env} and {service} into a pattern (folded label)", () => {
    expect(
      resolveServiceDomain(
        { domain: "testing.agentsystem.dev", domainPattern: "{service}-{env}.agentsystem.dev", service: "ui" },
        "dev",
      ),
    ).toBe("ui-dev.agentsystem.dev");
  });

  it("supports a domain nested under the prod domain (any depth)", () => {
    expect(
      resolveServiceDomain(
        { domain: "testing.agentsystem.dev", domainPattern: "ui-{env}.testing.agentsystem.dev", service: "ui" },
        "dev",
      ),
    ).toBe("ui-dev.testing.agentsystem.dev");
  });
});

describe("domainPattern validation", () => {
  const web = {
    name: "api",
    cpu: 256,
    memory: 256,
    domain: "api.acme.com",
    port: 3000,
    healthCheck: { path: "/healthz" },
  };

  it("rejects a pattern missing the {env} token", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, domainPattern: "api.acme.com" }] }),
    ).toThrow(/must include the \{env\} token/);
  });

  it("rejects an unknown token", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, domainPattern: "api-{env}-{region}.acme.com" }] }),
    ).toThrow(/unknown token/);
  });

  it("rejects patterns that do not resolve to hostnames", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, domainPattern: "https://api-{env}.acme.com" }] }),
    ).toThrow(/domainPattern must resolve to a DNS hostname/);
    expect(() =>
      parseLaunchPadConfig({ project: "p", domainPattern: "*.{env}.acme.com", service: [web] }),
    ).toThrow(/domainPattern must resolve to a DNS hostname/);
  });

  it("rejects patterns whose labels overflow 63 chars with max-length token values", () => {
    // 24 static chars + "-" + {env} max 40 = 65 > 63 — must be caught at parse time
    const longPrefix = "a".repeat(24);
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...web, domainPattern: `${longPrefix}-{env}.acme.com` }] }),
    ).toThrow(/domainPattern must resolve to a DNS hostname/);
  });

  it("rejects a domainPattern on a worker", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ name: "w", cpu: 256, memory: 256, domainPattern: "w-{env}.acme.com" }],
      }),
    ).toThrow(/only applies to a web service/);
  });

  it("accepts a valid service-level and project-level pattern", () => {
    // {service}-{env} in one label overflows (40+1+40=81 chars), so use separate labels
    const cfg = parseLaunchPadConfig({
      project: "p",
      domainPattern: "{service}.{env}.acme.com",
      service: [{ ...web, domainPattern: "api-{env}.acme.com" }],
    });
    expect(cfg.domainPattern).toBe("{service}.{env}.acme.com");
    expect(cfg.service[0]?.domainPattern).toBe("api-{env}.acme.com");
  });
});

describe("persistent volumes", () => {
  const vol = (over: Record<string, unknown> = {}) => ({
    name: "data",
    cpu: 256,
    memory: 256,
    volumes: [{ name: "data", path: "/data" }],
    ...over,
  });

  it("parses a service with a volume and defaults volumes to []", () => {
    const cfg = parseLaunchPadConfig({ project: "p", service: [vol(), worker] });
    expect(cfg.service[0]?.volumes).toEqual([{ name: "data", path: "/data" }]);
    // a service without volumes gets the [] default
    expect(cfg.service[1]?.volumes).toEqual([]);
  });

  it("allows a web service with a volume", () => {
    const cfg = parseLaunchPadConfig({
      project: "p",
      service: [{ ...web, volumes: [{ name: "uploads", path: "/var/uploads" }] }],
    });
    expect(cfg.service[0]?.volumes).toEqual([{ name: "uploads", path: "/var/uploads" }]);
  });

  it("rejects a relative or root volume path", () => {
    expect(() => parseLaunchPadConfig({ project: "p", service: [vol({ volumes: [{ name: "data", path: "data" }] })] })).toThrow(
      /must be absolute/,
    );
    expect(() => parseLaunchPadConfig({ project: "p", service: [vol({ volumes: [{ name: "data", path: "/" }] })] })).toThrow(
      /container root/,
    );
  });

  it("rejects a volume path with a '..' segment", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [vol({ volumes: [{ name: "data", path: "/data/../etc" }] })] }),
    ).toThrow(/'\.\.' segments/);
  });

  it("rejects duplicate volume names and duplicate paths", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [vol({ volumes: [{ name: "data", path: "/a" }, { name: "data", path: "/b" }] })],
      }),
    ).toThrow(/duplicate volume name/);
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [vol({ volumes: [{ name: "a", path: "/data" }, { name: "b", path: "/data" }] })],
      }),
    ).toThrow(/duplicate volume path/);
  });

  it("rejects an unknown key inside a volume", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [vol({ volumes: [{ name: "data", path: "/data", size: "10gb" }] })],
      }),
    ).toThrow();
  });
});
