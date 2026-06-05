import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./load";

const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../examples");

describe("example launch-pad.toml files", () => {
  const dirs = existsSync(examplesDir)
    ? readdirSync(examplesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(examplesDir, d.name))
        .filter((dir) => existsSync(join(dir, "launch-pad.toml")))
    : [];

  it.each(dirs)("parses %s", (dir) => {
    const { config } = loadConfig(dir);
    expect(config.service.length).toBeGreaterThan(0);
  });
});
