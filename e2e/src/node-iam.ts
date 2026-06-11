/**
 * launch-pad real-AWS regression for single-node IAM cleanup — `node destroy` must delete the
 * node's per-node IAM role + instance profile (previously only `cluster destroy` did, leaving
 * orphan roles/profiles accumulating in the account).
 *
 * No deploy needed (pure node lifecycle), so it's fast. Shells out to `aws iam` to assert the
 * role/profile exist after `node create` and are GONE after `node destroy`.
 *
 * Run with:  LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:node-iam   (add `--keep` to skip teardown)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { makeCli } from "./cli";
import { assert, note, printSummary, step } from "./report";

interface DestroyJson {
  destroyed: string[];
  warnings: string[];
}

/** Mirror of cli `iamSlug` + `nodeRoleName`/`nodeProfileName` (IAM names max 64 chars). */
function iamSlug(cluster: string, node: string): string {
  return `${cluster}-${node}`.replace(/[^a-zA-Z0-9+=,.@_-]/g, "-");
}
const roleName = (cluster: string, node: string): string => `launch-pad-node-${iamSlug(cluster, node)}`.slice(0, 64);
const profileName = (cluster: string, node: string): string => `launch-pad-node-profile-${iamSlug(cluster, node)}`.slice(0, 64);

/** True when an `aws iam` lookup finds the entity (exit 0); false on NoSuchEntity (non-zero). */
async function iamExists(args: string[], region: string): Promise<boolean> {
  const res = await execa("aws", ["iam", ...args], {
    reject: false,
    env: { ...(process.env as Record<string, string>), AWS_REGION: region },
  });
  return res.exitCode === 0;
}

async function main(): Promise<boolean> {
  if (process.env.LAUNCHPAD_E2E !== "1") {
    process.stderr.write(
      "LAUNCHPAD_E2E is not set to 1 — skipping the live AWS node-iam e2e.\n" +
        "Run it with: LAUNCHPAD_E2E=1 [AWS_PROFILE=…] pnpm e2e:node-iam\n",
    );
    return false;
  }

  const keep = process.argv.includes("--keep") || process.env.LAUNCHPAD_E2E_KEEP === "1";
  const region = process.env.LAUNCHPAD_E2E_REGION ?? "us-east-1";
  const runId = randomBytes(3).toString("hex");
  const cluster = `e2e-iam-${runId}`;
  const node = "iam-both";

  const home = mkdtempSync(join(tmpdir(), "launch-pad-home-"));
  const cli = makeCli({ home, region });

  const role = roleName(cluster, node);
  const profile = profileName(cluster, node);
  note(`run ${runId} · cluster ${cluster} · region ${region}`);
  note(`expecting IAM role ${role} + profile ${profile}`);

  const teardown = async (): Promise<void> => {
    await step("destroy the cluster (cleanup)", async () => {
      const out = await cli.json<DestroyJson>(["cluster", "destroy", cluster, "--yes"]);
      note(`destroyed nodes: ${out.destroyed.join(", ") || "(none)"}`);
    }).catch(() => {});
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    await step("create cluster + a both node (provisions per-node IAM)", async () => {
      await cli.run(["cluster", "create", cluster, "--region", region]);
      await cli.run(["node", "create", node, "--role", "both", "--cluster", cluster, "--yes"]);
    });

    await step("the per-node IAM role + instance profile exist after create", async () => {
      assert(await iamExists(["get-role", "--role-name", role], region), `IAM role ${role} exists`);
      assert(
        await iamExists(["get-instance-profile", "--instance-profile-name", profile], region),
        `instance profile ${profile} exists`,
      );
    });

    await step("node destroy removes the instance AND the per-node IAM", async () => {
      await cli.run(["node", "destroy", node, "--cluster", cluster, "--yes"]);
      assert(!(await iamExists(["get-role", "--role-name", role], region)), `IAM role ${role} is gone`);
      assert(
        !(await iamExists(["get-instance-profile", "--instance-profile-name", profile], region)),
        `instance profile ${profile} is gone`,
      );
    });
  } finally {
    if (keep) {
      note(`--keep set — leaving cluster "${cluster}". Tear it down later with:`);
      note(`  LAUNCHPAD_HOME=${home} launch-pad cluster destroy ${cluster} --yes`);
    } else {
      await teardown();
    }
  }

  return true;
}

main()
  .then((ran) => {
    process.exitCode = ran ? (printSummary() ? 0 : 1) : 0;
  })
  .catch((error) => {
    process.stderr.write(`\n${error?.stack ?? String(error)}\n`);
    process.exitCode = printSummary() ? 1 : 1;
  });
