/**
 * Pure planning for the `launch-pad setup` first-run wizard. The command resolves the
 * AWS account + region (and prompts interactively), then this derives what setup will do:
 * which state bucket to ensure, and whether a local `~/.launch-pad` target gets saved (only
 * for a NAMED cluster — the implicit `default` cluster runs on ambient AWS creds, so there's
 * nothing to persist locally). Kept pure so the bucket-name derivation + the default-vs-named
 * branch are unit-tested without touching AWS or the filesystem.
 */
import { DEFAULT_CLUSTER, stateBucketName } from "@agentsystemlabs/launch-pad-shared";

export interface SetupPlan {
  accountId: string;
  region: string;
  cluster: string;
  /** The account+region-scoped state bucket setup will ensure exists. */
  bucket: string;
  /** True for the implicit `default` cluster (ambient creds, no local target). */
  isDefaultCluster: boolean;
  /** True when setup will write a `~/.launch-pad/config.toml` target (named cluster only). */
  savesLocalTarget: boolean;
}

export function buildSetupPlan(accountId: string, region: string, cluster: string): SetupPlan {
  const isDefaultCluster = cluster === DEFAULT_CLUSTER;
  return {
    accountId,
    region,
    cluster,
    bucket: stateBucketName(accountId, region),
    isDefaultCluster,
    savesLocalTarget: !isDefaultCluster,
  };
}
