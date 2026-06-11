import { type ServiceConfig, serviceKey } from "./desired";

/** Reject incoming entries not owned by `project` (a caller bug — never publish them). */
function assertOwned(project: string, incoming: ServiceConfig[], fn: string): void {
  for (const s of incoming) {
    if (s.project !== project) {
      throw new Error(
        `${fn}: incoming service ${serviceKey(s.project, s.service)} is not owned by project "${project}"`,
      );
    }
  }
}

/** Throw on any duplicate `(project, service)` in the merged set. */
function assertNoDuplicates(merged: ServiceConfig[], fn: string): void {
  const seen = new Set<string>();
  for (const s of merged) {
    const key = serviceKey(s.project, s.service);
    if (seen.has(key)) {
      throw new Error(`${fn}: duplicate service on node: ${key}`);
    }
    seen.add(key);
  }
}

/**
 * Ownership-aware FULL merge of one project's services into a node's existing
 * service set. Every entry owned by `project` is dropped and replaced by
 * `incoming`; every other project's services are left untouched. This is the
 * source-of-truth merge for a deploy that publishes the project's WHOLE
 * footprint (a normal `deploy` of every service, or `rebalance`): a service the
 * config no longer places here is correctly removed.
 *
 * Returns a NEW array (no mutation). Throws if the result would contain a
 * duplicate `(project, service)`.
 *
 * ⚠️ Do NOT use this for a partial/subset deploy (`deploy --service` /
 * `deploy --changed`, and the `scale`/`config` edits that wrap them) — it would
 * drop the project's co-located siblings that the subset deploy didn't republish.
 * Use {@link mergeProjectServicesPartial} there.
 */
export function mergeProjectServices(
  existing: ServiceConfig[],
  project: string,
  incoming: ServiceConfig[],
): ServiceConfig[] {
  assertOwned(project, incoming, "mergeProjectServices");

  const others = existing.filter((s) => s.project !== project);
  const merged = [...others, ...incoming];

  assertNoDuplicates(merged, "mergeProjectServices");
  return merged;
}

/**
 * Ownership-aware PARTIAL (subset) merge: UPSERT only `incoming` by service name
 * into the node's existing set, preserving every service it doesn't mention —
 * the project's other co-located services AND every other project's services.
 *
 * This is what a subset deploy must use. A partial deploy (`deploy --service` /
 * `deploy --changed`, or `scale`/`config set`, which re-run a single-service
 * deploy) only knows about the service(s) it republishes; using the full-replace
 * {@link mergeProjectServices} there would silently delete the project's other
 * services from this node's desired.json, and the agent would tear down their
 * containers on its next poll.
 *
 * Existing entries are replaced in place (stable order); brand-new incoming
 * services are appended. Returns a NEW array (no mutation). Throws on a
 * foreign-owned incoming service or a duplicate `(project, service)`.
 */
export function mergeProjectServicesPartial(
  existing: ServiceConfig[],
  project: string,
  incoming: ServiceConfig[],
): ServiceConfig[] {
  assertOwned(project, incoming, "mergeProjectServicesPartial");

  const byService = new Map<string, ServiceConfig>(incoming.map((s) => [s.service, s]));
  const applied = new Set<string>();
  const merged: ServiceConfig[] = [];
  for (const s of existing) {
    const replacement = s.project === project ? byService.get(s.service) : undefined;
    if (replacement) {
      merged.push(replacement);
      applied.add(replacement.service);
    } else {
      merged.push(s);
    }
  }
  // Append incoming services that weren't already present on the node.
  for (const s of incoming) {
    if (!applied.has(s.service)) merged.push(s);
  }

  assertNoDuplicates(merged, "mergeProjectServicesPartial");
  return merged;
}
