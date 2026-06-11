import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readServiceSecrets,
  registerServiceSecret,
  unregisterServiceSecret,
} from "./toml-secrets";

const dirs: string[] = [];

function tempProject(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-secret-"));
  dirs.push(dir);
  writeFileSync(join(dir, "launch-pad.toml"), toml);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("toml-secrets", () => {
  it("registers and unregisters secret key names", () => {
    const dir = tempProject(`project = "my-app"

[[service]]
name = "api"
node = "node-1"
cpu = 512
memory = 512
domain = "app.example.com"
port = 3000

  [service.healthCheck]
  path = "/healthz"
`);

    expect(readServiceSecrets(dir, "api")).toEqual([]);
    expect(registerServiceSecret(dir, "api", "DATABASE_URL")).toBe(true);
    expect(readServiceSecrets(dir, "api")).toEqual(["DATABASE_URL"]);
    expect(registerServiceSecret(dir, "api", "DATABASE_URL")).toBe(false);
    expect(unregisterServiceSecret(dir, "api", "DATABASE_URL")).toBe(true);
    expect(readServiceSecrets(dir, "api")).toEqual([]);
  });

  it("updates only the selected service and stores key names, not values", () => {
    const dir = tempProject(`project = "my-app"

[[service]]
name = "api"
node = "node-1"
cpu = 512
memory = 512
secrets = ["EXISTING_API_KEY"]

[[service]]
name = "worker"
node = "node-1"
cpu = 256
memory = 256
secrets = ["WORKER_TOKEN"]
`);

    expect(registerServiceSecret(dir, "api", "DATABASE_URL")).toBe(true);

    expect(readServiceSecrets(dir, "api")).toEqual(["EXISTING_API_KEY", "DATABASE_URL"]);
    expect(readServiceSecrets(dir, "worker")).toEqual(["WORKER_TOKEN"]);
    expect(readFileSync(join(dir, "launch-pad.toml"), "utf8")).not.toContain("postgres://");
  });
});
