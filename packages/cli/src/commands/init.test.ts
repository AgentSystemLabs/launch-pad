import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { LABEL_REGEX, parseLaunchPadConfig } from "@agentsystemlabs/launch-pad-shared";
import { renderToml, toLabel } from "./init";

const base = { name: "app", node: "node-dev-1", dockerfile: "./Dockerfile", cpu: 512, memory: 512 };

describe("toLabel", () => {
  it("passes through an already-valid label", () => {
    expect(toLabel("my-app")).toBe("my-app");
  });

  it("lowercases and replaces invalid characters", () => {
    expect(toLabel("My Cool App!")).toBe("my-cool-app");
  });

  it("trims leading/trailing hyphens", () => {
    expect(toLabel("__weird__")).toBe("weird");
  });

  it("falls back to 'app' for empty/unusable input", () => {
    expect(toLabel("!!!")).toBe("app");
    expect(toLabel("")).toBe("app");
  });

  it("always produces a string that satisfies LABEL_REGEX", () => {
    for (const input of ["My Cool App!", "node_express_app", "123", "a".repeat(60)]) {
      expect(LABEL_REGEX.test(toLabel(input))).toBe(true);
    }
  });
});

describe("renderToml", () => {
  it("generates a web config that passes schema validation (includes a healthCheck)", () => {
    const toml = renderToml("app", { ...base, domain: "app.example.com", port: 3000 });
    expect(toml).toContain("[service.healthCheck]");
    expect(() => parseLaunchPadConfig(parseToml(toml))).not.toThrow();
    const cfg = parseLaunchPadConfig(parseToml(toml));
    expect(cfg.service[0]?.healthCheck?.path).toBe("/healthz");
  });

  it("generates a worker config (no domain → no healthCheck) that validates", () => {
    const toml = renderToml("app", base);
    expect(toml).not.toContain("[service.healthCheck]");
    expect(() => parseLaunchPadConfig(parseToml(toml))).not.toThrow();
  });
});
