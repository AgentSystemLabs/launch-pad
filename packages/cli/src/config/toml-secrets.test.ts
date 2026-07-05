import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readServiceSecrets,
  registerServiceSecret,
  registerServiceSecrets,
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

  it("batch-registers many keys in one write and returns only the newly added", () => {
    const dir = tempProject(`project = "my-app"

[[service]]
name = "api"
cpu = 512
memory = 512
secrets = ["EXISTING_API_KEY"]
`);

    const added = registerServiceSecrets(dir, "api", [
      "EXISTING_API_KEY",
      "DATABASE_URL",
      "STRIPE_KEY",
    ]);
    expect(added).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(readServiceSecrets(dir, "api")).toEqual([
      "EXISTING_API_KEY",
      "DATABASE_URL",
      "STRIPE_KEY",
    ]);
    // Re-registering the same set is a no-op.
    expect(registerServiceSecrets(dir, "api", ["DATABASE_URL", "STRIPE_KEY"])).toEqual([]);
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

  it("treats managed database password secrets as implicitly registered", () => {
    const dir = tempProject(`project = "my-app"

[[service]]
name = "api"
cpu = 512
memory = 512

[[database]]
name = "primary"
engine = "postgres"
version = "16"
`);

    expect(readServiceSecrets(dir, "primary")).toEqual(["POSTGRES_PASSWORD"]);
    expect(registerServiceSecret(dir, "primary", "POSTGRES_PASSWORD")).toBe(false);
    expect(unregisterServiceSecret(dir, "primary", "POSTGRES_PASSWORD")).toBe(false);
    expect(readFileSync(join(dir, "launch-pad.toml"), "utf8")).toContain('name = "primary"');
  });

  it("registers and reads secrets on one-off jobs", () => {
    const dir = tempProject(`project = "my-app"

[[service]]
name = "api"
cpu = 512
memory = 512

[[job]]
name = "migrate"
cpu = 256
memory = 128
`);

    expect(readServiceSecrets(dir, "migrate")).toEqual([]);
    expect(registerServiceSecret(dir, "migrate", "DATABASE_URL")).toBe(true);
    expect(readServiceSecrets(dir, "migrate")).toEqual(["DATABASE_URL"]);
    expect(unregisterServiceSecret(dir, "migrate", "DATABASE_URL")).toBe(true);
    expect(readServiceSecrets(dir, "migrate")).toEqual([]);
  });
});
