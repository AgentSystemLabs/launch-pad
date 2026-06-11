import { describe, expect, it } from "vitest";
import { LAUNCH_PAD_ENVIRONMENT } from "./constants";
import {
  NODE_ID_REGEX,
  nodeIdError,
  containerEnvForDeploy,
  envProject,
  isWebService,
  parseLaunchPadConfig,
  resolveServiceDomain,
  targetNodes,
  usesClusterPlacement,
} from "./config";

const web = {
  name: "web",
  node: "node-dev-1",
  cpu: 512,
  memory: 512,
  domain: "app.example.com",
  port: 3000,
  healthCheck: { path: "/healthz" },
};

const worker = {
  name: "worker",
  node: "node-dev-1",
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

  it("rejects unknown top-level keys", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "my-app", service: [worker], extra: true }),
    ).toThrow();
  });
});

describe("replicas / placement / edge validation", () => {
  const health = { healthCheck: { path: "/healthz" } };

  it("defaults replicas to 1 and rollout to sane values", () => {
    const cfg = parseLaunchPadConfig({ project: "my-app", service: [web] });
    expect(cfg.service[0]?.replicas).toBe(1);
    expect(cfg.service[0]?.rollout).toEqual({ maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" });
  });

  it("rejects invalid node ids in service declarations", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, node: "bad node" }] }),
    ).toThrow(/node must be letters, numbers, hyphens, or underscores/);
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...web, node: undefined, nodes: ["ok_node", "-bad"], edge: "edge-1", ...health }],
      }),
    ).toThrow(/node must be letters, numbers, hyphens, or underscores/);
  });

  it("rejects `node` and `nodes` together", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, nodes: ["a"] }] }),
    ).toThrow(/set `node` or `nodes`, not both/);
  });

  it("allows omitting placement (resolved at deploy via --cluster)", () => {
    const cfg = parseLaunchPadConfig({
      project: "p",
      service: [{ ...web, node: undefined, replicas: 2, ...health }],
    });
    expect(targetNodes(cfg.service[0]!)).toEqual([]);
    expect(usesClusterPlacement(cfg.service[0]!)).toBe(true);
  });

  it("rejects deprecated `cluster` in a service with a migration hint", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, node: undefined, cluster: "lower" }] }),
    ).toThrow(/cluster.*not supported in launch-pad\.toml.*--cluster/);
  });

  it("rejects unsupported service keys with a clear path", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, environment: "staging" }] }),
    ).toThrow(/service\[0\]\.environment: unsupported key/);
  });

  it("targetNodes returns the single node or the list", () => {
    const single = parseLaunchPadConfig({ project: "p", service: [worker] });
    expect(targetNodes(single.service[0]!)).toEqual(["node-dev-1"]);
    expect(usesClusterPlacement(single.service[0]!)).toBe(false);
    const multi = parseLaunchPadConfig({
      project: "p",
      service: [{ ...web, node: undefined, nodes: ["a", "b"], edge: "e", ...health }],
    });
    expect(targetNodes(multi.service[0]!)).toEqual(["a", "b"]);
  });

  it("rejects edge on a worker", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, edge: "e" }] }),
    ).toThrow(/only web services/);
  });

  it("requires an edge when a web service spans multiple nodes", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...web, node: undefined, nodes: ["a", "b"], ...health }],
      }),
    ).toThrow(/needs a dedicated `edge`/);
    // with edge → ok
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...web, node: undefined, nodes: ["a", "b"], edge: "e", ...health }],
      }),
    ).not.toThrow();
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

describe("schedule / topology validation", () => {
  const health = { healthCheck: { path: "/healthz" } };
  /** A cluster-placed web service (no node/nodes). */
  const clusterWeb = { ...web, node: undefined, ...health };
  const clusterWorker = { ...worker, node: undefined };

  it("defaults to schedule = even and topology = auto when omitted", () => {
    const cfg = parseLaunchPadConfig({ project: "p", service: [clusterWeb, clusterWorker] });
    expect(cfg.service[0]?.schedule).toBe("even");
    expect(cfg.service[0]?.topology).toBe("auto");
    expect(cfg.service[1]?.schedule).toBe("even");
    expect(cfg.service[1]?.topology).toBe("auto");
  });

  it("accepts capacity + each topology on a cluster-placed web service", () => {
    for (const topology of ["split", "co-located", "auto"]) {
      const cfg = parseLaunchPadConfig({
        project: "p",
        service: [{ ...clusterWeb, schedule: "capacity", topology }],
      });
      expect(cfg.service[0]?.schedule).toBe("capacity");
      expect(cfg.service[0]?.topology).toBe(topology);
    }
  });

  it("accepts co-located (and capacity) on a worker", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...clusterWorker, schedule: "capacity", topology: "co-located" }],
      }),
    ).not.toThrow();
  });

  it("rejects an EXPLICIT schedule alongside node — even the default value", () => {
    // The key matrix case: "even" matches the default, but writing it next to a
    // pinned node is still a contradiction the user should hear about.
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, schedule: "even" }] }),
    ).toThrow(/`schedule` only applies to cluster auto-placement/);
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...web, node: undefined, nodes: ["a"], schedule: "capacity", ...health }],
      }),
    ).toThrow(/`schedule` only applies to cluster auto-placement/);
  });

  it("rejects topology alongside node/nodes", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...worker, topology: "auto" }] }),
    ).toThrow(/`topology` only applies to cluster auto-placement/);
  });

  it("rejects split on a worker", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...clusterWorker, topology: "split" }] }),
    ).toThrow(/a worker has no ingress to split/);
  });

  it("rejects co-located together with an explicit edge", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ ...clusterWeb, topology: "co-located", edge: "edge-1" }],
      }),
    ).toThrow(/serves the domain from the service's own node — remove `edge`/);
  });

  it("rejects unknown enum values", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...clusterWeb, schedule: "spread" }] }),
    ).toThrow();
    expect(() =>
      parseLaunchPadConfig({ project: "p", service: [{ ...clusterWeb, topology: "pinned" }] }),
    ).toThrow();
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
    node: "n1",
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

  it("rejects a domainPattern on a worker", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "p",
        service: [{ name: "w", node: "n1", cpu: 256, memory: 256, domainPattern: "w-{env}.acme.com" }],
      }),
    ).toThrow(/only applies to a web service/);
  });

  it("accepts a valid service-level and project-level pattern", () => {
    const cfg = parseLaunchPadConfig({
      project: "p",
      domainPattern: "{service}-{env}.acme.com",
      service: [{ ...web, domainPattern: "api-{env}.acme.com" }],
    });
    expect(cfg.domainPattern).toBe("{service}-{env}.acme.com");
    expect(cfg.service[0]?.domainPattern).toBe("api-{env}.acme.com");
  });
});
