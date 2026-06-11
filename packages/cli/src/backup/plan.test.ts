import { describe, expect, it } from "vitest";
import { backupPrefixesForCluster, isSafeBackupKey, keyUnderPrefixes } from "./plan";

describe("backupPrefixesForCluster", () => {
  it("sweeps the legacy un-prefixed roots for the default cluster", () => {
    expect(backupPrefixesForCluster("default")).toEqual(["nodes/", "projects/"]);
  });

  it("sweeps the clusters/<id>/ prefix for a named cluster", () => {
    expect(backupPrefixesForCluster("prod")).toEqual(["clusters/prod/"]);
  });

  it("default and named prefixes never overlap", () => {
    const def = backupPrefixesForCluster("default");
    const named = backupPrefixesForCluster("prod");
    // A named cluster's keys live under clusters/, which no default prefix covers.
    expect(named.some((p) => def.some((d) => p.startsWith(d) || d.startsWith(p)))).toBe(false);
  });
});

describe("isSafeBackupKey", () => {
  it("accepts clean state keys", () => {
    expect(isSafeBackupKey("clusters/prod/cluster.json")).toBe(true);
    expect(isSafeBackupKey("nodes/n1/desired.json")).toBe(true);
    expect(isSafeBackupKey("projects/app/config-baseline.json")).toBe(true);
  });

  it("rejects path traversal, absolute paths, and the manifest itself", () => {
    expect(isSafeBackupKey("")).toBe(false);
    expect(isSafeBackupKey("manifest.json")).toBe(false);
    expect(isSafeBackupKey("/etc/passwd")).toBe(false);
    expect(isSafeBackupKey("../secret")).toBe(false);
    expect(isSafeBackupKey("clusters/../x")).toBe(false);
    expect(isSafeBackupKey("a//b")).toBe(false);
    expect(isSafeBackupKey("a\\b")).toBe(false);
    expect(isSafeBackupKey("a/./b")).toBe(false);
    expect(isSafeBackupKey("a\0b")).toBe(false);
  });
});

describe("keyUnderPrefixes", () => {
  it("matches a key under one of the prefixes", () => {
    expect(keyUnderPrefixes("clusters/prod/cluster.json", ["clusters/prod/"])).toBe(true);
    expect(keyUnderPrefixes("nodes/n1/desired.json", ["nodes/", "projects/"])).toBe(true);
  });

  it("rejects a key outside every prefix (cross-cluster restore guard)", () => {
    expect(keyUnderPrefixes("nodes/n1/desired.json", ["clusters/prod/"])).toBe(false);
    expect(keyUnderPrefixes("clusters/other/cluster.json", ["clusters/prod/"])).toBe(false);
  });
});
