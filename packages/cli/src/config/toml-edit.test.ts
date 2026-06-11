import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { parseLaunchPadConfig } from "@agentsystemlabs/launch-pad-shared";
import {
  readServiceNumericField,
  setServiceEnvVar,
  setServiceNumericField,
  unsetServiceEnvVar,
} from "./toml-edit";

const dirs: string[] = [];

function tempProject(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-edit-"));
  dirs.push(dir);
  writeFileSync(join(dir, "launch-pad.toml"), toml);
  return dir;
}

/** Re-read a service's value straight from the on-disk TOML. */
function reread(dir: string, service: string, key: string): unknown {
  const doc = parseToml(readFileSync(join(dir, "launch-pad.toml"), "utf8")) as Record<string, unknown>;
  const svcs = (Array.isArray(doc.service) ? doc.service : [doc.service]) as Array<Record<string, unknown>>;
  return svcs.find((s) => String(s.name) === service)?.[key];
}

const TWO_SERVICE_TOML = `project = "my-app"

[[service]]
name = "web"
node = "node-1"
cpu = 256
memory = 256
replicas = 2
domain = "app.example.com"
port = 3000
env = { NODE_ENV = "production" }

  [service.healthCheck]
  path = "/healthz"

[[service]]
name = "worker"
node = "node-1"
cpu = 256
memory = 512
replicas = 1
`;

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("setServiceNumericField", () => {
  it("changes replicas and reports the previous value", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    const edit = setServiceNumericField(dir, "web", "replicas", 4);
    expect(edit).toMatchObject({ field: "replicas", previous: 2, next: 4, changed: true });
    expect(reread(dir, "web", "replicas")).toBe(4);
    // Only the targeted service is touched.
    expect(reread(dir, "worker", "replicas")).toBe(1);
  });

  it("changes cpu and memory independently", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    setServiceNumericField(dir, "web", "cpu", 512);
    setServiceNumericField(dir, "web", "memory", 1024);
    expect(reread(dir, "web", "cpu")).toBe(512);
    expect(reread(dir, "web", "memory")).toBe(1024);
  });

  it("is a no-op (changed=false) and does not rewrite when the value is unchanged", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    const before = readFileSync(join(dir, "launch-pad.toml"), "utf8");
    const edit = setServiceNumericField(dir, "web", "replicas", 2);
    expect(edit).toMatchObject({ previous: 2, next: 2, changed: false });
    expect(readFileSync(join(dir, "launch-pad.toml"), "utf8")).toBe(before);
  });

  it("records previous=undefined when the field was relying on a schema default", () => {
    // `worker` declares no replicas in TOML (defaults to 1); editing should report
    // previous=undefined since nothing was written there before.
    const dir = tempProject(`project = "p"

[[service]]
name = "worker"
node = "n1"
cpu = 256
memory = 256
`);
    const edit = setServiceNumericField(dir, "worker", "replicas", 3);
    expect(edit).toMatchObject({ previous: undefined, next: 3, changed: true });
    expect(reread(dir, "worker", "replicas")).toBe(3);
  });

  it("rejects non-positive / non-integer values", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    expect(() => setServiceNumericField(dir, "web", "replicas", 0)).toThrow(/replicas/);
    expect(() => setServiceNumericField(dir, "web", "cpu", -5)).toThrow(/cpu/);
    expect(() => setServiceNumericField(dir, "web", "memory", 1.5)).toThrow(/memory/);
  });

  it("throws when the service does not exist", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    expect(() => setServiceNumericField(dir, "nope", "replicas", 2)).toThrow(/nope/);
  });

  it("produces a TOML that still validates against the schema", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    setServiceNumericField(dir, "web", "replicas", 3);
    const doc = parseToml(readFileSync(join(dir, "launch-pad.toml"), "utf8"));
    const config = parseLaunchPadConfig(doc);
    expect(config.service.find((s) => s.name === "web")?.replicas).toBe(3);
  });
});

describe("readServiceNumericField", () => {
  it("reads the declared value, or undefined when not declared", () => {
    const dir = tempProject(`project = "p"

[[service]]
name = "web"
node = "n1"
cpu = 256
memory = 256
replicas = 2

[[service]]
name = "worker"
node = "n1"
cpu = 256
memory = 256
`);
    expect(readServiceNumericField(dir, "web", "replicas")).toBe(2);
    expect(readServiceNumericField(dir, "worker", "replicas")).toBeUndefined();
  });
});

describe("setServiceEnvVar / unsetServiceEnvVar", () => {
  it("adds, updates, and removes an env var on the targeted service only", () => {
    const dir = tempProject(TWO_SERVICE_TOML);

    const added = setServiceEnvVar(dir, "web", "FEATURE_X", "on");
    expect(added).toMatchObject({ key: "FEATURE_X", previous: undefined, next: "on", changed: true });
    expect(reread(dir, "web", "env")).toMatchObject({ NODE_ENV: "production", FEATURE_X: "on" });

    const updated = setServiceEnvVar(dir, "web", "NODE_ENV", "staging");
    expect(updated).toMatchObject({ key: "NODE_ENV", previous: "production", next: "staging", changed: true });
    expect(reread(dir, "web", "env")).toMatchObject({ NODE_ENV: "staging" });

    const removed = unsetServiceEnvVar(dir, "web", "FEATURE_X");
    expect(removed).toMatchObject({ key: "FEATURE_X", previous: "on", next: undefined, changed: true });
    expect(reread(dir, "web", "env")).not.toHaveProperty("FEATURE_X");

    // worker had no env block at all — untouched.
    expect(reread(dir, "worker", "env")).toBeUndefined();
  });

  it("creates an env block when the service had none", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    setServiceEnvVar(dir, "worker", "QUEUE", "default");
    expect(reread(dir, "worker", "env")).toMatchObject({ QUEUE: "default" });
  });

  it("set is a no-op when the value already matches; unset is a no-op when absent", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    const before = readFileSync(join(dir, "launch-pad.toml"), "utf8");
    expect(setServiceEnvVar(dir, "web", "NODE_ENV", "production").changed).toBe(false);
    expect(unsetServiceEnvVar(dir, "web", "DOES_NOT_EXIST").changed).toBe(false);
    expect(readFileSync(join(dir, "launch-pad.toml"), "utf8")).toBe(before);
  });

  it("throws when the service does not exist", () => {
    const dir = tempProject(TWO_SERVICE_TOML);
    expect(() => setServiceEnvVar(dir, "nope", "K", "v")).toThrow(/nope/);
    expect(() => unsetServiceEnvVar(dir, "nope", "K")).toThrow(/nope/);
  });
});
