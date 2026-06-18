import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { applyProductionEnvAlias, isProductionEnvAlias, normalizeProductionEnvAlias } from "./env";

describe("isProductionEnvAlias", () => {
  it.each(["prod", "production", "PROD", "Production"])("treats %s as a production alias", (env) => {
    expect(isProductionEnvAlias(env)).toBe(true);
  });

  it.each(["staging", "pr-42", "prod-backup", "default"])("does not treat %s as production", (env) => {
    expect(isProductionEnvAlias(env)).toBe(false);
  });
});

describe("normalizeProductionEnvAlias", () => {
  it("passes through undefined and real env names", () => {
    expect(normalizeProductionEnvAlias(undefined)).toEqual({ env: undefined, alias: undefined });
    expect(normalizeProductionEnvAlias("staging")).toEqual({ env: "staging", alias: undefined });
  });

  it("maps production aliases to the base footprint", () => {
    expect(normalizeProductionEnvAlias("prod")).toEqual({ env: undefined, alias: "prod" });
    expect(normalizeProductionEnvAlias("production")).toEqual({ env: undefined, alias: "production" });
    expect(normalizeProductionEnvAlias("PROD")).toEqual({ env: undefined, alias: "PROD" });
  });
});

describe("applyProductionEnvAlias", () => {
  it("clears --env prod before the action reads options", () => {
    const cmd = new Command("deploy").option("--env <name>");
    cmd.parse(["node", "deploy", "--env", "prod"], { from: "user" });
    applyProductionEnvAlias(cmd);
    expect(cmd.opts().env).toBeUndefined();
  });

  it("leaves non-production env names alone", () => {
    const cmd = new Command("deploy").option("--env <name>");
    cmd.parse(["node", "deploy", "--env", "staging"], { from: "user" });
    applyProductionEnvAlias(cmd);
    expect(cmd.opts().env).toBe("staging");
  });
});
