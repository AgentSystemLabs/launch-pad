import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packBuildContext } from "./context-pack";

async function entriesOf(file: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file,
    onReadEntry: (entry) => {
      entries.push(entry.path.replace(/^\.\//, "").replace(/\/$/, ""));
    },
  });
  return entries.filter((e) => e !== "" && e !== ".").sort();
}

describe("packBuildContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "launch-pad-ctx-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(dir, "server.js"), "// app\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.js"), "// src\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "node_modules", "express"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "express", "index.js"), "// dep\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("packs the context, honoring .dockerignore literals and always dropping .git", async () => {
    writeFileSync(join(dir, ".dockerignore"), "node_modules\n*.log\n");
    const { file, bytes } = await packBuildContext(dir);
    try {
      expect(bytes).toBeGreaterThan(0);
      const entries = await entriesOf(file);
      expect(entries).toContain("Dockerfile");
      expect(entries).toContain("server.js");
      expect(entries).toContain("src/index.js");
      // .dockerignore itself ships so docker applies the FULL pattern set remotely.
      expect(entries).toContain(".dockerignore");
      expect(entries.some((e) => e.startsWith(".git"))).toBe(false);
      expect(entries.some((e) => e.startsWith("node_modules"))).toBe(false);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("always ships the dockerfile and .dockerignore, even when .dockerignore excludes them", async () => {
    // Excluding `Dockerfile` / `.dockerignore` in .dockerignore is legal and common:
    // docker reads both out-of-band, never from the context. The remote tarball IS
    // the context CodeBuild sees, so they must ship regardless.
    writeFileSync(join(dir, ".dockerignore"), "Dockerfile\n.dockerignore\nnode_modules\n");
    const { file } = await packBuildContext(dir, { alwaysInclude: ["Dockerfile"] });
    try {
      const entries = await entriesOf(file);
      expect(entries).toContain("Dockerfile");
      expect(entries).toContain(".dockerignore");
      expect(entries.some((e) => e.startsWith("node_modules"))).toBe(false);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("packs everything except .git when there is no .dockerignore", async () => {
    const { file } = await packBuildContext(dir);
    try {
      const entries = await entriesOf(file);
      expect(entries).toContain("node_modules/express/index.js");
      expect(entries.some((e) => e.startsWith(".git"))).toBe(false);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
