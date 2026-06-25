import { describe, expect, it } from "vitest";
import {
  databaseImage,
  databaseServiceNames,
  expandDatabaseServices,
  isDatabaseService,
  parseLaunchPadConfig,
  type LaunchPadConfig,
} from "./config";
import {
  POSTGRES_DATA_PATH,
  POSTGRES_PASSWORD_SECRET,
  POSTGRES_VOLUME_NAME,
} from "./constants";
import { snapshotConfigBaseline, findConfigLockViolations } from "./config-lock";
import {
  backupDatabasePrefix,
  backupObjectKey,
  backupServicePrefix,
  backupsBucketName,
} from "./s3-keys";

const worker = { name: "worker", cpu: 256, memory: 256 };

const dbBlock = {
  name: "primary",
  databases: ["app", "analytics"],
  backup: { schedule: "0 3 * * *", retentionDays: 7 },
};

describe("parseLaunchPadConfig with [[database]]", () => {
  it("parses a database block and applies engine/version/cpu/memory defaults", () => {
    const cfg = parseLaunchPadConfig({
      project: "shop",
      service: [worker],
      database: [{ name: "primary" }],
    });
    const db = cfg.database?.[0];
    expect(db?.engine).toBe("postgres");
    expect(db?.version).toBe("16");
    expect(db?.cpu).toBe(1024);
    expect(db?.memory).toBe(1024);
    expect(db?.databases).toEqual([]);
  });

  it("rejects an unknown key inside a [[database]] block", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "p", port: 5432 }] }),
    ).toThrow(/database\[0\]\.port: unsupported key/);
  });

  it("rejects an unknown key inside [database.backup]", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "shop",
        service: [worker],
        database: [{ name: "p", backup: { schedule: "0 3 * * *", target: "s3" } }],
      }),
    ).toThrow(/database\[0\]\.backup\.target: unsupported key/);
  });

  it("rejects an unparseable backup schedule", () => {
    expect(() =>
      parseLaunchPadConfig({
        project: "shop",
        service: [worker],
        database: [{ name: "p", backup: { schedule: "not a cron" } }],
      }),
    ).toThrow(/backup/i);
  });

  it("rejects an invalid postgres version", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "p", version: "latest" }] }),
    ).toThrow(/version must be a postgres image tag/);
  });

  it("rejects a database name that collides with a service name", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", service: [{ ...worker, name: "primary" }], database: [{ name: "primary" }] }),
    ).toThrow(/collides with an existing service or database/);
  });

  it("rejects two databases with the same name", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "p" }, { name: "p" }] }),
    ).toThrow(/collides/);
  });

  it("rejects an invalid logical database name", () => {
    expect(() =>
      parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "p", databases: ["bad-name"] }] }),
    ).toThrow(/valid postgres identifier/);
  });
});

describe("expandDatabaseServices", () => {
  it("desugars a database into a sticky worker service with the engine image markers", () => {
    const cfg = parseLaunchPadConfig({ project: "shop", service: [worker], database: [dbBlock] });
    const expanded = expandDatabaseServices(cfg);

    expect(expanded.database).toEqual([]);
    expect(expanded.service.map((s) => s.name)).toEqual(["worker", "primary"]);

    const db = expanded.service.find((s) => s.name === "primary")!;
    expect(isDatabaseService(db)).toBe(true);
    expect(db.database).toEqual({ engine: "postgres", version: "16", databases: ["app", "analytics"] });
    expect(db.volumes).toEqual([{ name: POSTGRES_VOLUME_NAME, path: POSTGRES_DATA_PATH }]);
    expect(db.secrets).toEqual([POSTGRES_PASSWORD_SECRET]);
    expect(db.backup).toEqual({ schedule: "0 3 * * *", retentionDays: 7 });
    // A worker — no ingress, so it routes through no edge and the scheduler stickies it.
    expect(db.domain).toBeUndefined();
    expect(db.port).toBeUndefined();
  });

  it("is a no-op when there are no databases", () => {
    const cfg = parseLaunchPadConfig({ project: "shop", service: [worker] });
    expect(expandDatabaseServices(cfg)).toBe(cfg);
  });

  it("omits backup on a database without a [database.backup] block", () => {
    const cfg = parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "primary" }] });
    const db = expandDatabaseServices(cfg).service.find((s) => s.name === "primary")!;
    expect(db.backup).toBeUndefined();
    expect(db.database).toBeDefined();
  });
});

describe("databaseImage", () => {
  it("pins the public-ECR postgres image, never Docker Hub", () => {
    expect(databaseImage({ engine: "postgres", version: "16" })).toBe(
      "public.ecr.aws/docker/library/postgres:16",
    );
    expect(databaseImage({ engine: "postgres", version: "15.6" })).toBe(
      "public.ecr.aws/docker/library/postgres:15.6",
    );
  });
});

describe("databaseServiceNames", () => {
  it("lists database names before expansion", () => {
    const cfg = parseLaunchPadConfig({
      project: "shop",
      service: [worker],
      database: [{ name: "primary" }, { name: "cache" }],
    });
    expect(databaseServiceNames(cfg)).toEqual(["primary", "cache"]);
  });
});

describe("config-lock for managed databases", () => {
  const config = (db: Record<string, unknown>): LaunchPadConfig =>
    expandDatabaseServices(
      parseLaunchPadConfig({ project: "shop", service: [worker], database: [{ name: "primary", ...db }] }),
    );

  it("freezes the engine + version (a version bump is a migration)", () => {
    const base = snapshotConfigBaseline(config({ version: "16" }), "t0");
    const bumped = snapshotConfigBaseline(config({ version: "17" }), "t1");
    const violations = findConfigLockViolations(base, bumped);
    expect(violations.some((v) => v.path === "service.primary")).toBe(true);
  });

  it("allows changing the backup schedule, retention, and target databases (operational)", () => {
    const base = snapshotConfigBaseline(
      config({ databases: ["app"], backup: { schedule: "0 3 * * *", retentionDays: 7 } }),
      "t0",
    );
    const changed = snapshotConfigBaseline(
      config({ databases: ["app", "analytics"], backup: { schedule: "0 5 * * *", retentionDays: 30 } }),
      "t1",
    );
    expect(findConfigLockViolations(base, changed)).toEqual([]);
  });
});

describe("backup S3 key derivation", () => {
  it("derives the dedicated backups bucket name", () => {
    expect(backupsBucketName("123456789012", "us-east-1")).toBe(
      "launch-pad-backups-123456789012-us-east-1",
    );
  });

  it("builds a per-database, timestamped object key under cluster/owner/service", () => {
    expect(backupServicePrefix("default", "shop", "primary")).toBe("default/shop/primary/");
    expect(backupDatabasePrefix("default", "shop", "primary", "app")).toBe("default/shop/primary/app/");
    expect(backupObjectKey("default", "shop", "primary", "app", "2026-06-25T03-00-00Z")).toBe(
      "default/shop/primary/app/2026-06-25T03-00-00Z.sql.gz",
    );
  });

  it("always cluster-prefixes (no legacy un-prefixed default) so the node IAM grant scopes cleanly", () => {
    expect(backupServicePrefix("lower", "shop--api", "primary")).toBe("lower/shop--api/primary/");
  });
});
