import {
  parseProjectIndex,
  type ProjectIndex,
  projectIndexKey,
  projectIndexPrefix,
  removeComponentEntry,
  upsertComponentEntry,
  type UpsertComponentInput,
} from "@agentsystemlabs/launch-pad-shared";
import type { AwsEnv } from "../aws/context";
import { awsErrorName } from "../aws/errors";
import { deleteObject, getJson, listObjectKeys, PreconditionFailedError, putJson } from "../aws/s3-state";
import { log } from "../ui/log";

/** Matches publishDesired's optimistic-concurrency retry budget. */
const MAX_INDEX_RETRIES = 5;

/**
 * The component index for one logical project, or null when the project has no
 * index (legacy / never deployed with this CLI version). An unreadable index is
 * treated as absent with a warning — the index is advisory (aggregation, destroy
 * fan-out, uniqueness pre-flight), never load-bearing for reconcile.
 */
export async function loadProjectIndex(aws: AwsEnv, project: string): Promise<ProjectIndex | null> {
  let obj;
  try {
    obj = await getJson(aws.s3, aws.bucket, projectIndexKey(aws.clusterId, project));
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return null;
    throw error;
  }
  if (!obj) return null;
  try {
    return parseProjectIndex(obj.raw);
  } catch {
    log.warn(`unreadable component index for "${project}" — ignoring (the next deploy rewrites it)`);
    return null;
  }
}

/** Every readable component index in the cluster (for `project list` aggregation). */
export async function loadProjectIndexes(aws: AwsEnv): Promise<ProjectIndex[]> {
  let keys: string[];
  try {
    keys = await listObjectKeys(aws.s3, aws.bucket, projectIndexPrefix(aws.clusterId));
  } catch (error) {
    if (awsErrorName(error) === "NoSuchBucket") return [];
    throw error;
  }
  const indexes: ProjectIndex[] = [];
  for (const key of keys) {
    const obj = await getJson(aws.s3, aws.bucket, key);
    if (!obj) continue;
    try {
      indexes.push(parseProjectIndex(obj.raw));
    } catch {
      log.warn(`unreadable component index at "${key}" — skipping`);
    }
  }
  return indexes;
}

/**
 * CAS upsert of one component's entry after a successful deploy. Best-effort
 * AFTER retries: concurrent deploys of sibling components race on this object,
 * so losers re-read and retry like publishDesired; if the budget is exhausted a
 * warning is logged and the deploy still succeeds (the next deploy repairs it).
 */
export async function upsertProjectIndex(aws: AwsEnv, input: UpsertComponentInput): Promise<void> {
  const key = projectIndexKey(aws.clusterId, input.project);
  for (let attempt = 0; attempt < MAX_INDEX_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, key);
    let index: ProjectIndex | null = null;
    if (existing) {
      try {
        index = parseProjectIndex(existing.raw);
      } catch {
        // Corrupt index: rebuild from scratch with this component's entry.
      }
    }
    const next = upsertComponentEntry(index, input);
    try {
      await putJson(aws.s3, aws.bucket, key, next, {
        ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }),
      });
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  log.warn(
    `could not update the component index for "${input.project}" (concurrent deploys racing) — the next deploy repairs it`,
  );
}

/**
 * CAS removal of one component's entry after its base footprint is destroyed.
 * Deletes the index object when the last component is removed. Best-effort like
 * the upsert — a stale entry only affects listings, never reconcile.
 */
export async function removeFromProjectIndex(
  aws: AwsEnv,
  project: string,
  component: string | undefined,
): Promise<void> {
  const key = projectIndexKey(aws.clusterId, project);
  for (let attempt = 0; attempt < MAX_INDEX_RETRIES; attempt += 1) {
    const existing = await getJson(aws.s3, aws.bucket, key);
    if (!existing) return;
    let index: ProjectIndex;
    try {
      index = parseProjectIndex(existing.raw);
    } catch {
      log.warn(`unreadable component index for "${project}" — leaving it for the next deploy to rewrite`);
      return;
    }
    const next = removeComponentEntry(index, component, new Date().toISOString());
    try {
      if (next === null) {
        await deleteObject(aws.s3, aws.bucket, key, { ifMatch: existing.etag });
      } else {
        await putJson(aws.s3, aws.bucket, key, next, { ifMatch: existing.etag });
      }
      return;
    } catch (error) {
      if (error instanceof PreconditionFailedError) continue;
      throw error;
    }
  }
  log.warn(`could not update the component index for "${project}" — a stale entry may linger in listings`);
}
