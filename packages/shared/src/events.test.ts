import { describe, expect, it } from "vitest";
import { DEPLOY_EVENT_VERSION } from "./constants";
import { buildDeployEvent, parseDeployEvent } from "./events";

const base = {
  at: "2026-06-10T12:00:00.000Z",
  by: "arn:aws:iam::493255580566:user/cody",
  cluster: "default",
  project: "shop",
  env: undefined,
  kind: "build" as const,
  services: [
    { service: "web", image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/web:v2", replicas: 2 },
    { service: "api", image: "123.dkr.ecr.us-east-1.amazonaws.com/shop/api:v2", replicas: 1 },
  ],
  converged: true,
};

describe("buildDeployEvent", () => {
  it("stamps the version, normalizes env to null, and sorts services by name", () => {
    const ev = buildDeployEvent(base);
    expect(ev.version).toBe(DEPLOY_EVENT_VERSION);
    expect(ev.env).toBeNull();
    expect(ev.services.map((s) => s.service)).toEqual(["api", "web"]);
    expect(ev.converged).toBe(true);
    expect(ev.kind).toBe("build");
  });

  it("keeps a named environment", () => {
    expect(buildDeployEvent({ ...base, env: "staging" }).env).toBe("staging");
  });

  it("records a null converged for a --no-wait deploy", () => {
    expect(buildDeployEvent({ ...base, converged: null }).converged).toBeNull();
  });

  it("round-trips through parseDeployEvent", () => {
    const ev = buildDeployEvent(base);
    expect(parseDeployEvent(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
  });
});

describe("parseDeployEvent", () => {
  it("defaults replicas/env/kind on an older record", () => {
    const ev = parseDeployEvent({
      version: DEPLOY_EVENT_VERSION,
      at: base.at,
      by: base.by,
      cluster: "default",
      project: "shop",
      services: [{ service: "web", image: "img" }],
      converged: null,
    });
    expect(ev.env).toBeNull();
    expect(ev.kind).toBe("build");
    expect(ev.services[0]!.replicas).toBe(0);
  });

  it("rejects a record with no services", () => {
    expect(() =>
      parseDeployEvent({ version: DEPLOY_EVENT_VERSION, at: base.at, by: base.by, cluster: "default", project: "shop", services: [], converged: true }),
    ).toThrow();
  });
});
