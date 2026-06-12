/**
 * launchpad real-AWS regression for the `launchpad setup` first-run wizard.
 *
 * Fast (no EC2, no Docker): exercises both paths of the bootstrap —
 *  - default cluster:  ensures the account+region state bucket exists (ambient creds, no
 *    local target). This is the common indie-hacker on-ramp so the first deploy doesn't 403.
 *  - named cluster:    ensures the (same) bucket, writes the cluster.json, and saves the local
 *    `~/.launch-pad` target. Cleaned up with `cluster destroy` — which must NOT delete the
 *    shared state bucket (it's per account+region, used by every cluster).
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:setup   (`--keep` skips teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { makeCli } from "./cli";
import { assert, assertEquals, note, printSummary, step } from "./report";

interface SetupJson {
  accountId: string;
  region: string;
  cluster: string;
  bucket: string;
  isDefaultCluster: boolean;
  savesLocalTarget: boolean;
  created: boolean;
}
interface ClusterShowJson {
  cluster?: { clusterId: string; region?: string } | null;
  clusterId?: string;
  region?: string;
}
interface DestroyJson {
  destroyed: string[];
  warnings: string[];
}

async function bucketExists(region: string, bucket: string): Promise<boolean> {
  const s3 = new S3Client({ region });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS setup e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:setup\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-setup-${runId}`;

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });
  let bucket = "";

  note(`run ${runId} · named cluster ${cluster} · region ${region} · no EC2`);
  note(`isolated LAUNCHPAD_HOME=${home}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the named cluster (must KEEP the shared state bucket)", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      assert(out.warnings.length === 0, `cluster destroy completed without warnings${out.warnings.length ? `: ${out.warnings.join("; ")}` : ""}`);
      if (bucket) {
        assert(await bucketExists(region, bucket), "the shared state bucket still exists after destroying the cluster");
      }
    }).catch(() => {
      /* recorded as a failed step; keep cleaning up */
    });
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    await step("setup (default cluster) ensures the state bucket, saves no local target", async () => {
      const out = await cli.json<SetupJson>(["setup", "--region", region, "--yes"]);
      assert(out.created, "setup reports the bucket is ready");
      assert(out.isDefaultCluster, "the default cluster is recognized as default");
      assert(!out.savesLocalTarget, "no local target is saved for the default cluster (ambient creds)");
      assert(/^launch-pad-state-\d{12}-/.test(out.bucket), `bucket name is account+region scoped (${out.bucket})`);
      bucket = out.bucket;
      assert(await bucketExists(region, bucket), "the state bucket exists in S3 after setup");
      note(`state bucket: ${bucket}`);
    });

    await step("setup (named cluster) saves a local target + cluster.json", async () => {
      const out = await cli.json<SetupJson>(["setup", "--cluster", cluster, "--region", region, "--yes"]);
      assert(out.created, "setup reports the bucket is ready");
      assert(!out.isDefaultCluster, "the named cluster is not the default");
      assert(out.savesLocalTarget, "a local target IS saved for a named cluster");
      assertEquals(out.cluster, cluster, "the planned cluster matches");
      assertEquals(out.bucket, bucket, "the named cluster shares the same account+region bucket");
    });

    await step("the named cluster is now resolvable (local target + cluster.json written)", async () => {
      const show = await cli.json<ClusterShowJson>(["cluster", "show", cluster]);
      const id = show.cluster?.clusterId ?? show.clusterId;
      assertEquals(id, cluster, "cluster show resolves the freshly set-up cluster");
      const shownRegion = show.cluster?.region ?? show.region;
      assertEquals(shownRegion, region, "cluster show reports the region setup saved");
    });
  } finally {
    if (keep) {
      note(`--keep set — leaving cluster "${cluster}" registered. Tear it down later with:`);
      note(`  LAUNCHPAD_HOME=${home} launchpad cluster destroy ${cluster} --yes`);
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
