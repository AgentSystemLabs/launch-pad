import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalConfig, setDefaultCluster, upsertClusterTarget } from "../../config/local";
import { CliError } from "../../errors";
import { applyClusterUse, buildClusterListRows } from "./index";

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

describe("applyClusterUse", () => {
  it("persists the default cluster for a locally-configured target", () => {
    upsertClusterTarget("prod", { region: "us-west-2" }, { setDefaultIfFirst: false });
    const result = applyClusterUse("prod");
    expect(result).toEqual({ defaultCluster: "prod" });
    expect(loadLocalConfig().defaultCluster).toBe("prod");
  });

  it("`use default` clears the persistent default (reverts to implicit)", () => {
    upsertClusterTarget("prod", { region: "us-west-2" });
    setDefaultCluster("prod");
    const result = applyClusterUse("default");
    expect(result).toEqual({ defaultCluster: null });
    expect(loadLocalConfig().defaultCluster).toBeUndefined();
    // the local target survives — only the default pointer is dropped.
    expect(loadLocalConfig().clusters.prod).toEqual({ region: "us-west-2" });
  });

  it("rejects an unknown cluster name with a create hint, leaving the default unchanged", () => {
    upsertClusterTarget("prod", { region: "us-west-2" });
    setDefaultCluster("prod");
    let err: unknown;
    try {
      applyClusterUse("ghost");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain("not configured locally");
    expect((err as CliError).hint).toContain("cluster create ghost");
    expect(loadLocalConfig().defaultCluster).toBe("prod");
  });
});

describe("buildClusterListRows", () => {
  it("always includes the implicit default cluster before named clusters", () => {
    const rows = buildClusterListRows(
      { clusters: { prod: { region: "us-west-2" } } },
      ["lower"],
      "us-east-1",
    );

    expect(rows).toEqual([
      { clusterId: "default", region: "us-east-1", source: "implicit" },
      { clusterId: "lower", region: "us-east-1", source: "s3" },
      { clusterId: "prod", region: "us-west-2", source: "local" },
    ]);
  });

  it("shows only the implicit default cluster when no named clusters exist", () => {
    expect(buildClusterListRows({ clusters: {} }, [], undefined)).toEqual([
      { clusterId: "default", region: null, source: "implicit" },
    ]);
  });
});
