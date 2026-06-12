import {
  PROTOCOL_VERSION,
  configBaselineKey,
  desiredKey,
  parseDesiredState,
  parseLaunchPadConfig,
  type ServiceConfig,
  snapshotConfigBaseline,
  type LaunchPadConfig,
} from "@agentsystemlabs/launch-pad-shared";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import type { AwsEnv } from "../aws/context";
import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import {
  assertSecretsPresent,
  enforceConfigLock,
  loadOverrideImage,
  publishDesired,
  resolveConfigLockOutcome,
  toServiceConfig,
} from "./deploy";

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

describe("enforceConfigLock — reconstructed from published desired state (no baseline file)", () => {
  const aws = () => makeAws({ desiredByNode: { "node-app": webDesired } });

  it("rejects a service rename before any build", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ name: "webgg" }), OWNER),
    ).rejects.toThrow(/only cpu, memory, replicas, env, secrets, domain, and domainPattern may change/);
  });

  it("allows a domain change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ domain: "other.example.com" }), OWNER),
    ).resolves.toBeUndefined();
  });

  it("allows a cpu/memory-only change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ cpu: 512, memory: 1024 }), OWNER),
    ).resolves.toBeUndefined();
  });

  it("allows a replicas change (scaling)", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ replicas: 3 }), OWNER),
    ).resolves.toBeUndefined();
  });

  it("allows an env change (non-secret config)", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ env: { NODE_ENV: "staging" } }), OWNER),
    ).resolves.toBeUndefined();
  });
});

describe("enforceConfigLock — authoritative S3 baseline file", () => {
  const baseline = snapshotConfigBaseline(makeConfig(), "now");
  const aws = () => makeAws({ baseline, desiredByNode: { "node-app": webDesired } });

  it("rejects a service rename", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ name: "webgg" }), OWNER),
    ).rejects.toThrow(/only cpu, memory, replicas, env, secrets, domain, and domainPattern may change/);
  });

  it("allows a cpu/memory-only change", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ cpu: 512, memory: 1024 }), OWNER),
    ).resolves.toBeUndefined();
  });

  it("allows replicas and env changes", async () => {
    await expect(
      enforceConfigLock(aws(), makeConfig({ replicas: 4, env: { NODE_ENV: "staging" } }), OWNER),
    ).resolves.toBeUndefined();
  });
});

describe("enforceConfigLock — first deploy", () => {
  it("allows anything when nothing is deployed yet", async () => {
    const aws = makeAws({ desiredByNode: {} });
    await expect(
      enforceConfigLock(aws, makeConfig({ name: "anything" }), OWNER),
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
      enforceConfigLock(aws, makeConfig({ name: "webgg" }), OWNER),
    ).rejects.toThrow(/could not read the config baseline/);
  });

  it("does NOT treat a corrupt baseline with no remaining desired state as a first deploy", async () => {
    const aws = makeAws({ baseline: { not: "a valid baseline" }, desiredByNode: {} });
    await expect(
      enforceConfigLock(aws, makeConfig({ name: "webgg" }), OWNER),
    ).rejects.toThrow(/corrupt/);
  });
});

describe("resolveConfigLockOutcome", () => {
  const baseline = snapshotConfigBaseline(makeConfig(), "now");
  const aws = () => makeAws({ baseline, desiredByNode: { "node-app": webDesired } });

  it("returns first-deploy when nothing is deployed yet", async () => {
    const outcome = await resolveConfigLockOutcome(makeAws({ desiredByNode: {} }), makeConfig(), OWNER);
    expect(outcome).toEqual({ kind: "first-deploy" });
  });

  it("returns clean for a mutable-only change", async () => {
    const outcome = await resolveConfigLockOutcome(aws(), makeConfig({ cpu: 512, replicas: 3 }), OWNER);
    expect(outcome).toEqual({ kind: "clean" });
  });

  it("returns clean for a domain change", async () => {
    const outcome = await resolveConfigLockOutcome(aws(), makeConfig({ domain: "other.example.com" }), OWNER);
    expect(outcome).toEqual({ kind: "clean" });
  });

  it("rejects an identity change against a baseline reconstructed from desired.json", async () => {
    const noBaseline = makeAws({ desiredByNode: { "node-app": webDesired } });
    await expect(
      resolveConfigLockOutcome(noBaseline, makeConfig({ name: "webgg" }), OWNER),
    ).rejects.toThrow(/only cpu, memory, replicas, env, secrets, domain, and domainPattern may change/);
  });
});

describe("deploy secrets", () => {
  it("publishes SSM refs in desired state without secret values", () => {
    const config = makeConfig({ secrets: ["DATABASE_URL"] });
    const decl = config.service[0]!;
    const svc = toServiceConfig(
      { clusterId: "default" } as AwsEnv,
      OWNER,
      {
        decl,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/repo:sha",
        domain: "app.agentsystem.dev",
      },
      1,
      "node-edge",
      undefined,
      false,
    );

    expect(svc.secretRefs).toEqual([
      {
        name: "DATABASE_URL",
        ssm: "/launch-pad/default/edge-express-web/web/DATABASE_URL",
      },
    ]);
    expect(JSON.stringify(svc)).not.toContain("postgres://");
  });

  it("carries a service's cron expression into desired state", () => {
    const config = makeConfig({});
    const decl = { ...config.service[0]!, domain: undefined, port: undefined, healthCheck: undefined, cron: "*/5 * * * *" };
    const svc = toServiceConfig(
      { clusterId: "default" } as AwsEnv,
      OWNER,
      { decl, image: "123.dkr.ecr.us-east-1.amazonaws.com/repo:sha", domain: undefined },
      1,
      null,
      undefined,
      false,
    );
    expect(svc.cron).toBe("*/5 * * * *");
    expect(svc.ingress).toBeNull();
  });

  it("sets restartAt without changing the image when restart mode publishes desired state", () => {
    const config = makeConfig({ secrets: ["DATABASE_URL"] });
    const svc = toServiceConfig(
      { clusterId: "default" } as AwsEnv,
      OWNER,
      {
        decl: config.service[0]!,
        image: "123.dkr.ecr.us-east-1.amazonaws.com/repo:already-published",
        domain: "app.agentsystem.dev",
      },
      1,
      "node-edge",
      undefined,
      true,
    );

    expect(svc.image).toBe("123.dkr.ecr.us-east-1.amazonaws.com/repo:already-published");
    expect(svc.restartAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("validates SSM refs without decrypting values", async () => {
    const config = makeConfig({ secrets: ["DATABASE_URL"] });
    const send = async (command: GetParametersCommand): Promise<unknown> => {
      expect(command).toBeInstanceOf(GetParametersCommand);
      expect(command.input.WithDecryption).toBe(false);
      expect(command.input.Names).toEqual([
        "/launch-pad/default/edge-express-web/web/DATABASE_URL",
      ]);
      return {
        Parameters: [{ Name: "/launch-pad/default/edge-express-web/web/DATABASE_URL" }],
      };
    };

    await expect(
      assertSecretsPresent({ clusterId: "default", ssm: { send } } as unknown as AwsEnv, config.service, OWNER),
    ).resolves.toBeUndefined();
  });

  it("fails before publish when a registered secret is missing in SSM", async () => {
    const config = makeConfig({ secrets: ["DATABASE_URL", "STRIPE_SECRET_KEY"] });
    const send = async (): Promise<unknown> => ({
      Parameters: [{ Name: "/launch-pad/default/edge-express-web/web/DATABASE_URL" }],
    });

    await expect(
      assertSecretsPresent({ clusterId: "default", ssm: { send } } as unknown as AwsEnv, config.service, OWNER),
    ).rejects.toThrow(/web\/STRIPE_SECRET_KEY/);
  });
});

describe("loadOverrideImage (deploy --image)", () => {
  const decl = () => makeConfig().service[0]!;
  const VALID = "123456789012.dkr.ecr.us-east-1.amazonaws.com/edge-express-web/web:sha-roll1";

  /** A fake ECR whose imageExists answers `exists` for a DescribeImages on the override tag. */
  function ecrAws(exists: boolean): AwsEnv {
    const send = async (command: { input?: { imageIds?: Array<{ imageTag?: string }> } }): Promise<unknown> => ({
      imageDetails: exists ? [{ imageTag: command.input?.imageIds?.[0]?.imageTag }] : [],
    });
    return { accountId: "123456789012", region: "us-east-1", ecr: { send } } as unknown as AwsEnv;
  }

  it("accepts a tag in the service's own repo that exists, returning the {service → image} map", async () => {
    const map = await loadOverrideImage(ecrAws(true), OWNER, decl(), VALID);
    expect(map.get("web")).toBe(VALID);
  });

  it("rejects a non-ECR / untagged URI before any AWS call", async () => {
    await expect(loadOverrideImage(ecrAws(true), OWNER, decl(), "ghcr.io/acme/web:v1")).rejects.toThrow(
      /invalid --image/,
    );
  });

  it("rejects an image from another account's ECR registry (can't pull cross-account)", async () => {
    const otherAccount = "999999999999.dkr.ecr.us-east-1.amazonaws.com/edge-express-web/web:sha-roll1";
    await expect(loadOverrideImage(ecrAws(true), OWNER, decl(), otherAccount)).rejects.toThrow(
      /must be in your account's ECR registry/,
    );
  });

  it("rejects an image from a different region's ECR registry", async () => {
    const otherRegion = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/edge-express-web/web:sha-roll1";
    await expect(loadOverrideImage(ecrAws(true), OWNER, decl(), otherRegion)).rejects.toThrow(
      /must be in your account's ECR registry/,
    );
  });

  it("rejects an image from a different repository (can't deploy another service's build)", async () => {
    const wrongRepo = "123456789012.dkr.ecr.us-east-1.amazonaws.com/edge-express-web/worker:sha-roll1";
    await expect(loadOverrideImage(ecrAws(true), OWNER, decl(), wrongRepo)).rejects.toThrow(
      /not in service "web"'s repository/,
    );
  });

  it("rejects a tag that does not exist in ECR", async () => {
    await expect(loadOverrideImage(ecrAws(false), OWNER, decl(), VALID)).rejects.toThrow(/not found in ECR/);
  });
});

describe("toServiceConfig — persistent volumes", () => {
  const aws = { clusterId: "default" } as unknown as AwsEnv;

  it("threads declared volumes into the published ServiceConfig", () => {
    const decl = parseLaunchPadConfig({
      project: "p",
      service: [{ name: "db", cpu: 256, memory: 256, volumes: [{ name: "data", path: "/data" }] }],
    }).service[0]!;
    const cfg = toServiceConfig(aws, "p", { decl, image: "img:abc" }, 1, null, undefined, false);
    expect(cfg.volumes).toEqual([{ name: "data", path: "/data" }]);
  });

  it("publishes an empty volume list for a service without volumes", () => {
    const decl = parseLaunchPadConfig({
      project: "p",
      service: [{ name: "w", cpu: 256, memory: 256 }],
    }).service[0]!;
    const cfg = toServiceConfig(aws, "p", { decl, image: "img:abc" }, 1, null, undefined, false);
    expect(cfg.volumes).toEqual([]);
  });
});

describe("toServiceConfig — web services require the cluster edge", () => {
  it("throws when a web service (domain+port) resolves no edge node", () => {
    const config = makeConfig();
    expect(() =>
      toServiceConfig(
        { clusterId: "default" } as AwsEnv,
        OWNER,
        { decl: config.service[0]!, image: "img:abc", domain: "app.agentsystem.dev" },
        1,
        null,
        undefined,
        false,
      ),
    ).toThrow(/serves a domain but resolved no edge node/);
  });

  it("publishes string ingress.edge for a web service routed through the edge", () => {
    const config = makeConfig();
    const cfg = toServiceConfig(
      { clusterId: "default" } as AwsEnv,
      OWNER,
      { decl: config.service[0]!, image: "img:abc", domain: "app.agentsystem.dev" },
      1,
      "node-edge",
      undefined,
      false,
    );
    expect(cfg.ingress).toEqual({ domain: "app.agentsystem.dev", port: 3000, edge: "node-edge" });
  });
});

describe("publishDesired — partial deploy preserves co-located siblings", () => {
  const NODE = "node-app";
  const cfgSvc = (service: string, image: string): ServiceConfig => ({
    project: OWNER,
    service,
    image,
    cpu: 256,
    memory: 256,
    replicas: 1,
    env: {},
    secretRefs: [],
    ingress: null,
    healthCheck: null,
    rollout: { maxSurge: 1, drainTimeout: "20s", stopGrace: "30s" },
    volumes: [],
  });

  /** Mock S3 that serves a desired.json with web+worker and captures the next write. */
  function makePublishAws(existingServices: ServiceConfig[]): { aws: AwsEnv; written: () => ServiceConfig[] | null } {
    let writtenBody: string | null = null;
    const send = async (command: { constructor: { name: string }; input?: Record<string, unknown> }): Promise<unknown> => {
      const kind = command.constructor.name;
      if (kind === "GetObjectCommand") {
        const key = command.input?.Key as string;
        if (key === desiredKey("default", NODE)) {
          const body = JSON.stringify({
            version: PROTOCOL_VERSION,
            nodeId: NODE,
            updatedAt: "now",
            services: existingServices,
          });
          return { Body: { transformToString: async () => body }, ETag: '"d"' };
        }
        const err = new Error("missing") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      if (kind === "PutObjectCommand") {
        writtenBody = command.input?.Body as string;
        return { ETag: '"d2"' };
      }
      throw new Error(`unexpected S3 command ${kind}`);
    };
    const aws = { clusterId: "default", bucket: "bucket", s3: { send } } as unknown as AwsEnv;
    return {
      aws,
      written: () => (writtenBody ? parseDesiredState(JSON.parse(writtenBody)).services : null),
    };
  }

  // Generous capacity so the merge — not an admission failure — is what's under test.
  const node = { totalCpu: 4096, totalMemory: 8192, reservedCpu: 0, reservedMemory: 0 } as NodeRegistryEntry;

  it("partial=true UPSERTS web and KEEPS the co-located worker (the bug fix)", async () => {
    const { aws, written } = makePublishAws([cfgSvc("web", "img:web-old"), cfgSvc("worker", "img:worker")]);
    await publishDesired(aws, NODE, node, OWNER, [cfgSvc("web", "img:web-new")], true);
    const services = written();
    expect(services?.map((s) => `${s.service}@${s.image}`).sort()).toEqual([
      "web@img:web-new",
      "worker@img:worker",
    ]);
  });

  it("partial=false (full deploy) REPLACES the footprint, dropping the unlisted worker", async () => {
    const { aws, written } = makePublishAws([cfgSvc("web", "img:web-old"), cfgSvc("worker", "img:worker")]);
    await publishDesired(aws, NODE, node, OWNER, [cfgSvc("web", "img:web-new")], false);
    expect(written()?.map((s) => s.service)).toEqual(["web"]);
  });
});
