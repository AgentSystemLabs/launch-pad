import { describe, expect, it } from "vitest";
import { isWebService, parseLaunchPadConfig } from "./config";

const web = {
  name: "web",
  node: "node-dev-1",
  cpu: 512,
  memory: 512,
  domain: "app.example.com",
  port: 3000,
};

const worker = {
  name: "worker",
  node: "node-dev-1",
  cpu: 256,
  memory: 256,
};

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
