import {
  PROTOCOL_VERSION,
  configBaselineKey,
  parseLaunchPadConfig,
  snapshotConfigBaseline,
  type LaunchPadConfig,
} from "@agentsystemlabs/launch-pad-shared";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../aws/context";
import { CliError } from "../errors";
import { enforceConfigLock } from "./deploy";

const OWNER = "edge-express-web";

/** The original, already-deployed config. Pass patches to model a user edit. */
function makeConfig(
  servicePatch: Record<string, unknown> = {},
  topPatch: Record<string, unknown> = {},
): LaunchPadConfig {
  return parseLaunchPadConfig({
    project: OWNER,
    service: [
      {
        name: "web",
        node: "node-app",
        edge: "node-edge",
        dockerfile: "./Dockerfile",
        context: ".",
        cpu: 256,
        memory: 256,
        env: { NODE_ENV: "production" },
        domain: "app.agentsystem.dev",
        port: 3000,
        healthCheck: { path: "/healthz" },
        ...servicePatch,
      },
    ],
    ...topPatch,
  });
}

/** desired.json as the agent reconciles it — what the lock's fallback path reads. */
const webDesired = {
  version: PROTOCOL_VERSION,
  nodeId: "node-app",
  updatedAt: "now",
  services: [
    {
      project: OWNER,
      service: "web",
      image: "1234.dkr.ecr.us-east-1.amazonaws.com/edge-express-web/web:sha-abc",
      cpu: 256,
      memory: 256,
      replicas: 1,
      env: { NODE_ENV: "production" },
      ingress: { domain: "app.agentsystem.dev", port: 3000, edge: "node-edge" },
      healthCheck: { path: "/healthz", port: 3000, intervalMs: 2000, timeoutMs: 2000, healthyThreshold: 2 },
      rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    },
  ],
};

class NoSuchKeyError extends Error {
  override name = "NoSuchKey";
}

interface MockS3Options {
  /** Body returned for projects/<owner>/config-baseline.json, or 404 when absent. */
  baseline?: unknown;
  /** desired.json body per node id (listed under nodes/<id>/). */
  desiredByNode?: Record<string, unknown>;
  /** Throw this on the config-baseline GetObject (e.g. a 403) instead of 404. */
  baselineError?: Error;
}

/** A fake AwsEnv whose S3 client answers only the keys the config lock touches. */
function makeAws(options: MockS3Options): AwsEnv {
  const desiredByNode = options.desiredByNode ?? {};
  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const kind = command.constructor.name;
    if (kind === "ListObjectsV2Command") {
      return {
        CommonPrefixes: Object.keys(desiredByNode).map((id) => ({ Prefix: `nodes/${id}/` })),
      };
    }
    if (kind === "GetObjectCommand") {
      const key = command.input?.Key as string;
      if (key === configBaselineKey("default", OWNER)) {
        if (options.baselineError) throw options.baselineError;
        if (options.baseline === undefined) throw new NoSuchKeyError("missing");
        return { Body: { transformToString: async () => JSON.stringify(options.baseline) }, ETag: '"b"' };
      }
      for (const [id, body] of Object.entries(desiredByNode)) {
        if (key === `nodes/${id}/desired.json`) {
          return { Body: { transformToString: async () => JSON.stringify(body) }, ETag: '"d"' };
        }
      }
      throw new NoSuchKeyError(key);
    }
    throw new Error(`unexpected S3 command ${kind}`);
  };
  return { clusterId: "default", bucket: "bucket", s3: { send } } as unknown as AwsEnv;
}

type Opts = Parameters<typeof enforceConfigLock>[3];
const noOpts = {} as Opts;

describe("enforceConfigLock — reconstructed from published desired state (no baseline file)", () => {
  const aws = () => makeAws({ desiredByNode: { "node-app": webDesired } });

  it("rejects a service rename before any build", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ name: "webgg" }), OWNER, noOpts),
    ).rejects.toThrow(/only cpu and memory may change/);
  });

  it("rejects a domain change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ domain: "other.example.com" }), OWNER, noOpts),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("allows a cpu/memory-only change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ cpu: 512, memory: 1024 }), OWNER, noOpts),
    ).resolves.toBeUndefined();
  });

  it("blocks --node after the initial deploy", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig(), OWNER, { node: "node-app-2" } as Opts),
    ).rejects.toThrow(/--node cannot be used/);
  });
});

describe("enforceConfigLock — authoritative S3 baseline file", () => {
  const baseline = snapshotConfigBaseline(makeConfig(), "now");
  const aws = () => makeAws({ baseline, desiredByNode: { "node-app": webDesired } });

  it("rejects a service rename", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ name: "webgg" }), OWNER, noOpts),
    ).rejects.toThrow(/only cpu and memory may change/);
  });

  it("allows a cpu/memory-only change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ cpu: 512, memory: 1024 }), OWNER, noOpts),
    ).resolves.toBeUndefined();
  });
});

describe("enforceConfigLock — first deploy", () => {
  it("allows anything when nothing is deployed yet", async () => {
    const aws = makeAws({ desiredByNode: {} });
    await expect(
      enforceConfigLock(aws, makeConfig({ name: "anything" }), OWNER, noOpts),
    ).resolves.toBeUndefined();
  });
});

describe("enforceConfigLock — fails loudly when deployed state can't be read", () => {
  it("does NOT treat a 403 on the baseline as a first deploy", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), {
      name: "Forbidden",
      $metadata: { httpStatusCode: 403 },
    });
    const aws = makeAws({ baselineError: forbidden });
    await expect(
      enforceConfigLock(aws, makeConfig({ name: "webgg" }), OWNER, noOpts),
    ).rejects.toThrow(/could not read the config baseline/);
  });

  it("does NOT treat a corrupt baseline with no remaining desired state as a first deploy", async () => {
    const aws = makeAws({ baseline: { not: "a valid baseline" }, desiredByNode: {} });
    await expect(
      enforceConfigLock(aws, makeConfig({ name: "webgg" }), OWNER, noOpts),
    ).rejects.toThrow(/corrupt/);
  });
});
