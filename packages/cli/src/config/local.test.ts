import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDefaultCluster,
  effectiveCluster,
  loadLocalConfig,
  rememberClusterTarget,
  resolveClusterTarget,
  setDefaultCluster,
  upsertClusterTarget,
} from "./local";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lp-home-"));
  prevHome = process.env.LAUNCHPAD_HOME;
  process.env.LAUNCHPAD_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LAUNCHPAD_HOME;
  else process.env.LAUNCHPAD_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("local config", () => {
  it("returns an empty config when no file exists", () => {
    expect(loadLocalConfig()).toEqual({ clusters: {} });
    expect(resolveClusterTarget("lower")).toBeUndefined();
  });

  it("round-trips a cluster target and makes the first one the default", () => {
    upsertClusterTarget("lower", { region: "us-east-1", profile: "dev" });
    const cfg = loadLocalConfig();
    expect(cfg.clusters.lower).toEqual({ region: "us-east-1", profile: "dev" });
    expect(cfg.defaultCluster).toBe("lower");
    expect(resolveClusterTarget("lower")).toEqual({ region: "us-east-1", profile: "dev" });
  });

  it("merges into an existing target and doesn't clobber the default", () => {
    upsertClusterTarget("lower", { region: "us-east-1" });
    upsertClusterTarget("prod", { region: "us-west-2", roleArn: "arn:aws:iam::222:role/x" });
    upsertClusterTarget("lower", { profile: "dev" });
    const cfg = loadLocalConfig();
    expect(cfg.defaultCluster).toBe("lower"); // first one stays default
    expect(cfg.clusters.lower).toEqual({ region: "us-east-1", profile: "dev" });
    expect(cfg.clusters.prod?.roleArn).toBe("arn:aws:iam::222:role/x");
  });

  it("can change the default cluster", () => {
    upsertClusterTarget("lower", { region: "us-east-1" });
    upsertClusterTarget("prod", { region: "us-west-2" });
    setDefaultCluster("prod");
    expect(loadLocalConfig().defaultCluster).toBe("prod");
  });

  it("rejects path-like cluster ids before writing local config", () => {
    expect(() => upsertClusterTarget("prod/../default", { region: "us-east-1" })).toThrow(
      /invalid cluster name/,
    );
    expect(loadLocalConfig()).toEqual({ clusters: {} });
  });

  it("clears the default cluster (reverting to implicit `default`)", () => {
    upsertClusterTarget("lower", { region: "us-east-1" });
    expect(loadLocalConfig().defaultCluster).toBe("lower");
    clearDefaultCluster();
    expect(loadLocalConfig().defaultCluster).toBeUndefined();
    // the cluster's local target is untouched — only the default pointer is dropped.
    expect(resolveClusterTarget("lower")).toEqual({ region: "us-east-1" });
  });

  it("clearDefaultCluster is a no-op when none is set", () => {
    upsertClusterTarget("lower", { region: "us-east-1" }, { setDefaultIfFirst: false });
    expect(loadLocalConfig().defaultCluster).toBeUndefined();
    clearDefaultCluster();
    expect(loadLocalConfig().defaultCluster).toBeUndefined();
  });
});

describe("effectiveCluster", () => {
  it("falls back to the implicit `default` with no flags and no config", () => {
    const eff = effectiveCluster({}, { clusters: {} });
    expect(eff).toMatchObject({
      cluster: "default",
      persistedDefault: "default",
      isImplicitDefault: true,
      overridden: false,
    });
    expect(eff.region).toBeUndefined();
  });

  it("uses the persisted default and its saved region/profile", () => {
    const eff = effectiveCluster(
      {},
      { defaultCluster: "prod", clusters: { prod: { region: "us-west-2", profile: "work" } } },
    );
    expect(eff).toMatchObject({
      cluster: "prod",
      persistedDefault: "prod",
      isImplicitDefault: false,
      overridden: false,
      region: "us-west-2",
      profile: "work",
    });
  });

  it("a --cluster flag overrides the persisted default and flags it", () => {
    const eff = effectiveCluster(
      { cluster: "staging" },
      { defaultCluster: "prod", clusters: { prod: { region: "us-west-2" }, staging: { region: "eu-west-1" } } },
    );
    expect(eff).toMatchObject({
      cluster: "staging",
      persistedDefault: "prod",
      overridden: true,
      region: "eu-west-1",
    });
  });

  it("a --cluster equal to the default is not an override", () => {
    const eff = effectiveCluster(
      { cluster: "prod" },
      { defaultCluster: "prod", clusters: { prod: { region: "us-west-2" } } },
    );
    expect(eff.overridden).toBe(false);
  });

  it("rejects path-like --cluster values before AWS resource names are derived", () => {
    expect(() => effectiveCluster({ cluster: "prod/../default" }, { clusters: {} })).toThrow(
      /invalid cluster name/,
    );
  });

  it("--region / --profile flags win over the saved target", () => {
    const eff = effectiveCluster(
      { cluster: "prod", region: "ap-south-1", profile: "other" },
      { clusters: { prod: { region: "us-west-2", profile: "work", roleArn: "arn:aws:iam::1:role/x" } } },
    );
    expect(eff).toMatchObject({ region: "ap-south-1", profile: "other", roleArn: "arn:aws:iam::1:role/x" });
  });

  it("upsert with setDefaultIfFirst=false records the target but leaves the default unset", () => {
    upsertClusterTarget("lower", { region: "us-east-1" }, { setDefaultIfFirst: false });
    const cfg = loadLocalConfig();
    expect(cfg.clusters.lower).toEqual({ region: "us-east-1" });
    expect(cfg.defaultCluster).toBeUndefined();
  });
});

describe("rememberClusterTarget", () => {
  it("records a cluster target without making it the default (implicit tracking)", () => {
    // Regression: `deploy --cluster lower` must surface in `cluster list` but must
    // NOT hijack the default — `node list` (no --cluster) still targets `default`.
    rememberClusterTarget("lower", { region: "us-east-1" });
    const cfg = loadLocalConfig();
    expect(cfg.clusters.lower).toEqual({ region: "us-east-1" });
    expect(cfg.defaultCluster).toBeUndefined();
    expect(resolveClusterTarget("lower")).toEqual({ region: "us-east-1" });
  });

  it("keeps profile but drops an undefined profile (TOML has no undefined)", () => {
    rememberClusterTarget("lower", { region: "us-east-1", profile: undefined });
    expect(loadLocalConfig().clusters.lower).toEqual({ region: "us-east-1" });
    rememberClusterTarget("prod", { region: "us-west-2", profile: "work" });
    expect(loadLocalConfig().clusters.prod).toEqual({ region: "us-west-2", profile: "work" });
  });

  it("is a no-op for the implicit `default` cluster", () => {
    rememberClusterTarget("default", { region: "us-east-1" });
    expect(loadLocalConfig()).toEqual({ clusters: {} });
  });

  it("does not overwrite an already-configured target", () => {
    upsertClusterTarget("lower", { region: "us-east-1", profile: "explicit" });
    rememberClusterTarget("lower", { region: "us-west-2", profile: "implicit" });
    expect(resolveClusterTarget("lower")).toEqual({ region: "us-east-1", profile: "explicit" });
  });
});
