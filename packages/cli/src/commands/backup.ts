import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Command } from "commander";
import { prepareAws } from "../aws/context";
import { getObjectText, listObjectKeys, putObjectText } from "../aws/s3-state";
import {
  BACKUP_MANIFEST_FILE,
  BACKUP_MANIFEST_VERSION,
  type BackupManifest,
  backupPrefixesForCluster,
  isSafeBackupKey,
  keyUnderPrefixes,
} from "../backup/plan";
import { CliError } from "../errors";
import { applyGlobalOptions, type GlobalOpts, mergedOpts } from "../globals";
import { panel, table } from "../ui/box";
import { isJsonMode, log, printJson } from "../ui/log";
import { confirm } from "../ui/prompt";
import { color } from "../ui/theme";

interface BackupOptions extends GlobalOpts {
  /** Output directory (default: launch-pad-backup-<cluster>-<timestamp>). */
  out?: string;
}

interface RestoreOptions extends GlobalOpts {
  /** Skip the overwrite confirmation. */
  yes?: boolean;
}

/** Launch Pad state objects are KBs; cap a restored file far above that so a tampered/
 *  corrupted backup can't push an oversized body to S3 (and to every node on reconcile). */
const MAX_RESTORE_OBJECT_BYTES = 5 * 1024 * 1024;

/** A filesystem-safe timestamp for the default backup directory name. */
function dirStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Every file under `dir`, recursively (absolute paths). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function runBackup(opts: BackupOptions): Promise<void> {
  const aws = await prepareAws(opts);
  const prefixes = backupPrefixesForCluster(aws.clusterId);

  const keys: string[] = [];
  for (const prefix of prefixes) keys.push(...(await listObjectKeys(aws.s3, aws.bucket, prefix)));

  const outDir = opts.out ?? `launch-pad-backup-${aws.clusterId}-${dirStamp()}`;
  const captured: string[] = [];
  for (const key of keys) {
    if (!isSafeBackupKey(key)) {
      log.warn(`skipping unsafe S3 key (won't round-trip): ${key}`);
      continue;
    }
    const body = await getObjectText(aws.s3, aws.bucket, key);
    if (body === null) continue; // raced a delete — skip
    const dest = join(outDir, ...key.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, "utf8");
    captured.push(key);
  }

  const manifest: BackupManifest = {
    version: BACKUP_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    account: aws.accountId,
    region: aws.region,
    cluster: aws.clusterId,
    bucket: aws.bucket,
    prefixes,
    keys: captured,
  };
  writeFileSync(join(outDir, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (isJsonMode()) {
    printJson({ dir: outDir, objects: captured.length, ...manifest });
    return;
  }
  panel(`Backup · ${aws.clusterId}`, [
    ...table([
      ["account / region", `${aws.accountId} ${color.dim(aws.region)}`],
      ["bucket", aws.bucket],
      ["objects", String(captured.length)],
      ["directory", outDir],
    ]),
    color.dim("state only (no plaintext secrets — desired.json carries SSM refs, not values)"),
  ]);
  if (captured.length === 0) {
    log.warn("no state found for this cluster — nothing was backed up");
  } else {
    log.success(`backed up ${captured.length} object(s) → ${outDir}`);
    log.dim(`restore with:  launchpad restore ${outDir}`);
  }
}

async function runRestore(dir: string, opts: RestoreOptions): Promise<void> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, BACKUP_MANIFEST_FILE), "utf8")) as BackupManifest;
  } catch {
    throw new CliError(`no ${BACKUP_MANIFEST_FILE} found in "${dir}"`, {
      hint: "point restore at a directory created by `launchpad backup`",
    });
  }
  if (manifest.version !== BACKUP_MANIFEST_VERSION) {
    throw new CliError(`unsupported backup version ${manifest.version} (this CLI writes v${BACKUP_MANIFEST_VERSION})`);
  }

  // Restore into the backup's own cluster by default; --cluster retargets (same key layout).
  const cluster = opts.cluster ?? manifest.cluster;
  const prefixes = backupPrefixesForCluster(cluster);

  // Build + validate the upload set BEFORE touching AWS, so a tampered backup fails closed.
  // Three guards, all pre-AWS: (1) the key is a clean relative path (no traversal), (2) it
  // stays within the target cluster's keyspace, and (3) it was actually recorded in the
  // manifest — so a file hand-added to the backup dir can't inject new desired-state.
  const manifestPath = join(dir, BACKUP_MANIFEST_FILE);
  const recorded = new Set(manifest.keys ?? []);
  const uploads: Array<{ key: string; body: string }> = [];
  for (const file of walkFiles(dir)) {
    if (file === manifestPath) continue;
    const key = relative(dir, file).split(sep).join("/");
    if (!isSafeBackupKey(key)) {
      throw new CliError(`refusing to restore unsafe key "${key}"`, { hint: "the backup directory looks tampered with" });
    }
    if (!keyUnderPrefixes(key, prefixes)) {
      throw new CliError(`backup key "${key}" is not under cluster "${cluster}" (${prefixes.join(", ")})`, {
        hint: "restore into the cluster the backup came from, or pass a matching --cluster",
      });
    }
    if (!recorded.has(key)) {
      throw new CliError(`backup file "${key}" is not listed in ${BACKUP_MANIFEST_FILE} — refusing`, {
        hint: "the backup directory was modified after it was taken; re-create it with `launchpad backup`",
      });
    }
    const { size } = statSync(file);
    if (size > MAX_RESTORE_OBJECT_BYTES) {
      throw new CliError(`backup file "${key}" is ${size} bytes (max ${MAX_RESTORE_OBJECT_BYTES}) — refusing`, {
        hint: "launchpad state objects are small; this file looks corrupted or tampered",
      });
    }
    uploads.push({ key, body: readFileSync(file, "utf8") });
  }
  if (uploads.length === 0) {
    throw new CliError(`no objects to restore in "${dir}"`, { hint: "the backup directory is empty" });
  }

  const aws = await prepareAws({ ...opts, cluster }, { ensureBucket: true });
  const sameBucket = manifest.bucket === aws.bucket;

  if (!isJsonMode()) {
    panel(`Restore · ${cluster}`, [
      ...table([
        ["from backup", `${manifest.bucket} ${color.dim(`(${manifest.createdAt})`)}`],
        ["into bucket", aws.bucket],
        ["objects", String(uploads.length)],
      ]),
      sameBucket
        ? color.yellow("overwrites existing state in this bucket for the cluster's keys")
        : color.yellow(`cross-bucket restore: backup is from ${manifest.bucket}, restoring into ${aws.bucket}`),
    ]);
  }

  const proceed =
    opts.yes === true ||
    (!isJsonMode() && (await confirm(`Upload ${uploads.length} object(s) to ${aws.bucket} (overwrites state)?`, false)));
  if (!proceed) {
    if (!isJsonMode()) log.info("aborted — nothing was restored");
    return;
  }

  for (const { key, body } of uploads) await putObjectText(aws.s3, aws.bucket, key, body);

  if (isJsonMode()) {
    printJson({ cluster, bucket: aws.bucket, restored: uploads.length });
    return;
  }
  log.success(`restored ${uploads.length} object(s) → ${aws.bucket}`);
  log.dim("nodes reconcile on their next poll; run `launchpad status` to watch them converge.");
}

export function registerBackup(program: Command): void {
  const backup = program
    .command("backup")
    .description("Export a cluster's S3 state (registry + desired/status + baselines + events) to a local directory")
    .option("--out <dir>", "output directory (default: launch-pad-backup-<cluster>-<timestamp>)")
    .addHelpText(
      "after",
      [
        "",
        "Mirrors the authoritative S3 state for the target cluster into a local directory keyed",
        "by S3 key, plus a manifest.json. Read-only — it never changes AWS. Contains NO plaintext",
        "secrets (desired.json stores SSM parameter references, not values).",
        "",
        "Examples:",
        "  $ launchpad backup",
        "  $ launchpad backup --cluster prod --out ./prod-backup",
      ].join("\n"),
    )
    .action(async (_opts, command: Command) => {
      await runBackup(mergedOpts<BackupOptions>(command));
    });
  applyGlobalOptions(backup);

  const restore = program
    .command("restore <dir>")
    .description("Re-upload a `backup` directory's S3 state (disaster recovery; overwrites existing state)")
    .option("--yes", "skip the overwrite confirmation (required in CI)")
    .addHelpText(
      "after",
      [
        "",
        "Re-uploads every object in a backup directory to S3 for the cluster recorded in its",
        "manifest (override with --cluster). Validates each key stays within the cluster's own",
        "keyspace before writing. Nodes reconcile to the restored desired state on their next poll.",
        "",
        "Examples:",
        "  $ launchpad restore ./launch-pad-backup-prod-2026-06-10T12-00-00-000Z",
        "  $ launchpad restore ./prod-backup --cluster prod --yes",
      ].join("\n"),
    )
    .action(async (dir: string, _opts, command: Command) => {
      await runRestore(dir, mergedOpts<RestoreOptions>(command));
    });
  applyGlobalOptions(restore);
}
