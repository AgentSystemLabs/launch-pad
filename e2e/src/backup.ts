/**
 * launch-pad real-AWS regression for `launch-pad backup` / `restore`.
 *
 * Fast (no EC2, no Docker): set up a named cluster (writes cluster.json), plant a synthetic
 * desired.json under its prefix, `backup` it to a local dir, DELETE both objects from S3
 * (simulating a disaster), `restore` the backup, and assert every object is back
 * byte-for-byte. Then `cluster destroy` — which must KEEP the shared state bucket.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:backup   (`--keep` skips teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { makeCli } from "./cli";
import { assert, assertEquals, note, printSummary, step } from "./report";

interface BackupJson {
  dir: string;
  objects: number;
  bucket: string;
  cluster: string;
  keys: string[];
}
interface RestoreJson {
  cluster: string;
  bucket: string;
  restored: number;
}
interface DestroyJson {
  destroyed: string[];
  warnings: string[];
}

async function getText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? "";
  } catch {
    return null;
  }
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS backup e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:backup\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-backup-${runId}`;

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const work = mkdtempSync(join(tmpdir(), "launch-pad-backup-"));
  const backupDir = join(work, "backup");
  const cli = makeCli({ home, region });
  const s3 = new S3Client({ region });

  let bucket = "";
  const fakeKey = `clusters/${cluster}/nodes/backup-fake/desired.json`;
  const fakeBody = `${JSON.stringify({ version: 1, services: [], note: `synthetic ${runId}` }, null, 2)}\n`;
  const clusterJsonKey = `clusters/${cluster}/cluster.json`;
  let clusterJsonBefore = "";

  note(`run ${runId} · cluster ${cluster} · region ${region} · backup/restore (no EC2)`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the cluster (KEEP the shared bucket)", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      assert(out.warnings.length === 0, `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`);
    }).catch(() => {
      /* recorded as a failed step; keep cleaning up */
    });
    try {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    await step("set up a named cluster + plant a synthetic desired.json", async () => {
      const setup = await cli.json<{ bucket: string }>(["setup", "--cluster", cluster, "--region", region, "--yes"]);
      bucket = setup.bucket;
      assert(!!bucket, "setup returned the state bucket");
      clusterJsonBefore = (await getText(s3, bucket, clusterJsonKey)) ?? "";
      assert(clusterJsonBefore.length > 0, "cluster.json exists after setup");
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: fakeKey, Body: fakeBody, ContentType: "application/json" }));
      note(`bucket: ${bucket}`);
    });

    await step("backup captures both objects to a local directory", async () => {
      const out = await cli.json<BackupJson>(["backup", "--cluster", cluster, "--out", backupDir]);
      assert(out.objects >= 2, `backup captured ${out.objects} object(s) (cluster.json + synthetic)`);
      assert(out.keys.includes(clusterJsonKey), "backup manifest lists cluster.json");
      assert(out.keys.includes(fakeKey), "backup manifest lists the synthetic desired.json");
      // The synthetic file on disk is byte-identical to what we uploaded.
      const onDisk = readFileSync(join(backupDir, fakeKey), "utf8");
      assertEquals(onDisk, fakeBody, "the backed-up file matches the original bytes");
    });

    await step("simulate a disaster: delete both objects from S3", async () => {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: [{ Key: clusterJsonKey }, { Key: fakeKey }], Quiet: true },
        }),
      );
      assertEquals(await getText(s3, bucket, fakeKey), null, "the synthetic object is gone from S3");
      assertEquals(await getText(s3, bucket, clusterJsonKey), null, "cluster.json is gone from S3");
    });

    await step("restore re-uploads the backup byte-for-byte", async () => {
      const out = await cli.json<RestoreJson>(["restore", backupDir, "--cluster", cluster, "--yes"]);
      assert(out.restored >= 2, `restore re-uploaded ${out.restored} object(s)`);
      assertEquals(await getText(s3, bucket, fakeKey), fakeBody, "the synthetic object is restored byte-for-byte");
      assertEquals(await getText(s3, bucket, clusterJsonKey), clusterJsonBefore, "cluster.json is restored byte-for-byte");
    });

    await step("the restored cluster resolves again", async () => {
      const show = await cli.json<{ cluster?: { clusterId: string } }>(["cluster", "show", cluster]);
      assertEquals(show.cluster?.clusterId, cluster, "cluster show works after restore");
    });
  } finally {
    if (keep) {
      note(`--keep set — leaving cluster "${cluster}" + backup dir ${backupDir}`);
      note(`  LAUNCHPAD_HOME=${home} launch-pad cluster destroy ${cluster} --yes`);
    } else {
      await teardown();
    }
  }

  return true;
}

main()
  .then((ran) => {
    if (!ran) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = printSummary() ? 0 : 1;
  })
  .catch((error) => {
    process.stderr.write(`\n${error?.stack ?? String(error)}\n`);
    process.exitCode = printSummary() ? 1 : 1;
  });
