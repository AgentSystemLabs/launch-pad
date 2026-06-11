import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "@agentsystemlabs/launch-pad-shared";
import { buildRunArgs, type RunSpec, volumeName } from "./docker";

function svc(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    project: "blog",
    service: "api",
    image: "ecr/blog/api:abc",
    cpu: 512,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
    ...over,
  };
}

/** Pull the value that follows each occurrence of `flag` in an argv array. */
function valuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]!);
  });
  return out;
}

describe("volumeName", () => {
  it("encodes the full project/service/volume tuple deterministically", () => {
    expect(volumeName("blog", "api", "data")).toBe("launchpadvol_blog_api_data");
    // stable across calls — the same data is re-mounted on container replace
    expect(volumeName("blog", "api", "data")).toBe(volumeName("blog", "api", "data"));
    // distinct services / volumes don't collide
    expect(volumeName("blog", "api", "data")).not.toBe(volumeName("blog", "web", "data"));
    expect(volumeName("blog", "api", "data")).not.toBe(volumeName("blog", "api", "cache"));
  });
});

describe("buildRunArgs — volume mounts", () => {
  it("adds a -v mount per volume, named by the tuple, mounted at the declared path", () => {
    const args = buildRunArgs(
      { config: svc({ volumes: [{ name: "data", path: "/data" }, { name: "cache", path: "/var/cache" }] }), index: 0, bindHost: "127.0.0.1" },
      {},
      "stamp",
    );
    expect(valuesAfter(args, "-v")).toEqual([
      "launchpadvol_blog_api_data:/data",
      "launchpadvol_blog_api_cache:/var/cache",
    ]);
  });

  it("adds no -v args for a service without volumes", () => {
    const args = buildRunArgs({ config: svc(), index: 0, bindHost: "127.0.0.1" }, {}, "stamp");
    expect(args).not.toContain("-v");
  });

  it("still wires env, ports, and the image alongside volumes", () => {
    const spec: RunSpec = {
      config: svc({
        volumes: [{ name: "data", path: "/data" }],
        env: { NODE_ENV: "production" },
        ingress: { domain: "app.example.com", port: 3000, edge: null },
      }),
      index: 0,
      hostPort: 49001,
      bindHost: "0.0.0.0",
    };
    const args = buildRunArgs(spec, { NODE_ENV: "production" }, "stamp");
    expect(valuesAfter(args, "-v")).toEqual(["launchpadvol_blog_api_data:/data"]);
    expect(valuesAfter(args, "-e")).toContain("NODE_ENV=production");
    expect(valuesAfter(args, "-p")).toEqual(["0.0.0.0:49001:3000"]);
    expect(args[args.length - 1]).toBe("ecr/blog/api:abc");
  });
});
