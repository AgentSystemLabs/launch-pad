import { type ServiceConfig, serviceKey } from "./desired";

/**
 * Ownership-aware merge of one project's services into a node's existing service
 * set. Every entry owned by `project` is dropped and replaced by `incoming`;
 * every other project's services are left untouched. Returns a NEW array (no
 * mutation). Throws if the result would contain a duplicate `(project, service)`.
 */
export function mergeProjectServices(
  existing: ServiceConfig[],
  project: string,
  incoming: ServiceConfig[],
): ServiceConfig[] {
  for (const s of incoming) {
    if (s.project !== project) {
      throw new Error(
        `mergeProjectServices: incoming service ${serviceKey(s.project, s.service)} is not owned by project "${project}"`,
      );
    }
  }

  const others = existing.filter((s) => s.project !== project);
  const merged = [...others, ...incoming];

  const seen = new Set<string>();
  for (const s of merged) {
    const key = serviceKey(s.project, s.service);
    if (seen.has(key)) {
      throw new Error(`mergeProjectServices: duplicate service on node: ${key}`);
    }
    seen.add(key);
  }

  return merged;
}
