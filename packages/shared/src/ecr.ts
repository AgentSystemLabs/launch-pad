/**
 * Pure parsing of ECR image references. Used to validate a `--image <uri>` override
 * (rollback / promote of an existing immutable tag) before it is published to a node's
 * desired.json — we only ever deploy a `:tag` (never a `@digest`) from the account's own
 * ECR registry, so anything else is rejected at the CLI surface.
 */

/** An ECR registry host: `<account-id>.dkr.ecr.<region>.amazonaws.com`. */
const ECR_REGISTRY_RE = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/;

export interface ParsedEcrImage {
  /** The registry host (no scheme), e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com`. */
  registry: string;
  /** The repository path, e.g. `my-app/web` (may contain slashes). */
  repository: string;
  /** The immutable tag, e.g. `sha-abc123`. */
  tag: string;
}

/**
 * Parse `<ecr-registry>/<repository>:<tag>` into its parts, or `null` when the string
 * isn't a tagged image in an ECR registry. Digest refs (`@sha256:…`) return null — we
 * deploy by immutable tag only.
 */
export function parseEcrImageUri(uri: string): ParsedEcrImage | null {
  if (uri.includes("@")) return null; // digest reference — unsupported

  const firstSlash = uri.indexOf("/");
  if (firstSlash <= 0) return null;

  const registry = uri.slice(0, firstSlash);
  if (!ECR_REGISTRY_RE.test(registry)) return null;

  const rest = uri.slice(firstSlash + 1); // `<repository>:<tag>`
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null; // no tag, or empty repository

  const repository = rest.slice(0, lastColon);
  const tag = rest.slice(lastColon + 1);
  if (repository.length === 0 || tag.length === 0) return null;

  return { registry, repository, tag };
}

/** One pushed image tag and when ECR recorded it (epoch ms or a Date). */
export interface ImageTagPushedAt {
  tag: string;
  pushedAt: number | Date;
}

const epochMs = (v: number | Date): number => (v instanceof Date ? v.getTime() : v);

/**
 * The tag to roll back to: the most-recently-pushed image strictly OLDER than the
 * currently-deployed `currentTag` (by ECR push time). Returns null when `currentTag`
 * isn't present or is already the oldest — rollback never rolls forward, and the caller
 * surfaces "nothing older; pass --to <tag>". Pure; tolerant of unsorted input.
 */
export function findPreviousImageTag(
  images: readonly ImageTagPushedAt[],
  currentTag: string,
): string | null {
  const current = images.find((i) => i.tag === currentTag);
  if (!current) return null;
  const currentMs = epochMs(current.pushedAt);

  let best: { tag: string; ms: number } | null = null;
  for (const i of images) {
    if (i.tag === currentTag) continue;
    const ms = epochMs(i.pushedAt);
    if (ms >= currentMs) continue; // newer-or-equal — rollback only goes older
    if (!best || ms > best.ms) best = { tag: i.tag, ms };
  }
  return best?.tag ?? null;
}
