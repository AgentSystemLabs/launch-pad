import { z } from "zod";
import { PROJECT_INDEX_VERSION } from "./constants";
import { componentOwner, LABEL_REGEX } from "./config";

/**
 * Component registry: one `projects/_index/<project>.json` per LOGICAL project,
 * mapping the project to every deployed component and the footprint owner each
 * component deploys under. It exists because owners are derived
 * (`<project>--<component>`) and never parsed back apart — this index IS the
 * owner → (project, component) mapping.
 *
 * Written by `deploy` (CAS upsert after a successful publish), trimmed by
 * `destroy` when a component's base footprint is torn down, and read by
 * `project list/show` (aggregation), `destroy --project` (fan-out), and the
 * deploy-time cross-component service-name uniqueness check (components share
 * one ECR namespace, `<project>/<service>`, so a duplicate service name across
 * components would silently share a repo).
 *
 * CLI-only advisory state — the agent never reads it; versioned separately from
 * the wire protocol. Entries record BASE components only: an env deploy
 * (`deploy --env`) upserts the same entry as a production deploy, because the
 * service set is config-wide, not per-env.
 */

/** Owner strings are derived labels joined by `-`/`--`; same shape preview markers enforce. */
const OWNER_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** Registry name for a TOML with no `component` field (owner = project itself). */
export const DEFAULT_COMPONENT = "default";

const ComponentEntrySchema = z
  .object({
    /** Component name from launch-pad.toml, or DEFAULT_COMPONENT when omitted. */
    component: z.string().regex(LABEL_REGEX),
    /** The component's BASE footprint owner (not env-projected). */
    owner: z.string().regex(OWNER_REGEX),
    /** Service names declared by the component's config (config-wide, all envs). */
    services: z.array(z.string().min(1)),
    /** ISO timestamp of the latest deploy that upserted this entry. */
    updatedAt: z.string().min(1),
  })
  .strict();

export const ProjectIndexSchema = z
  .object({
    version: z.literal(PROJECT_INDEX_VERSION),
    /** The logical project (`project` in launch-pad.toml). */
    project: z.string().regex(LABEL_REGEX),
    components: z.array(ComponentEntrySchema),
    /** ISO timestamp of the latest write. */
    updatedAt: z.string().min(1),
  })
  .strict();

export type ProjectComponentEntry = z.infer<typeof ComponentEntrySchema>;
export type ProjectIndex = z.infer<typeof ProjectIndexSchema>;

export function parseProjectIndex(input: unknown): ProjectIndex {
  return ProjectIndexSchema.parse(input);
}

/** The registry name a config's component records under (omitted → DEFAULT_COMPONENT). */
export function registryComponentName(component: string | undefined): string {
  return component ?? DEFAULT_COMPONENT;
}

export interface UpsertComponentInput {
  project: string;
  /** Component from the deploying TOML; undefined records as DEFAULT_COMPONENT. */
  component: string | undefined;
  /** Service names from the FULL config (not a `--service` subset). */
  services: string[];
  /** ISO timestamp of this deploy. */
  now: string;
}

/**
 * Add or refresh one component's entry. `index` may be null (first deploy of the
 * project). Entries are kept sorted by component name so re-writes are stable.
 */
export function upsertComponentEntry(index: ProjectIndex | null, input: UpsertComponentInput): ProjectIndex {
  const name = registryComponentName(input.component);
  const entry: ProjectComponentEntry = {
    component: name,
    owner: componentOwner(input.project, input.component),
    services: [...new Set(input.services)].sort(),
    updatedAt: input.now,
  };
  const others = (index?.components ?? []).filter((c) => c.component !== name);
  return {
    version: PROJECT_INDEX_VERSION,
    project: input.project,
    components: [...others, entry].sort((a, b) => a.component.localeCompare(b.component)),
    updatedAt: input.now,
  };
}

/**
 * Drop one component's entry after its base footprint is destroyed. Returns the
 * trimmed index, or null when the last component is removed — the caller should
 * then delete the index object entirely.
 */
export function removeComponentEntry(
  index: ProjectIndex,
  component: string | undefined,
  now: string,
): ProjectIndex | null {
  const name = registryComponentName(component);
  const remaining = index.components.filter((c) => c.component !== name);
  if (remaining.length === 0) return null;
  return { ...index, components: remaining, updatedAt: now };
}

export interface ServiceConflict {
  service: string;
  /** The OTHER component already claiming the service name. */
  component: string;
}

/**
 * Cross-component service-name collisions: services this config declares that a
 * DIFFERENT component of the same project already registered. Service names must
 * be unique across a project's components — they share one ECR repo namespace
 * (`<project>/<service>`). A null/absent index means no constraint (first deploy).
 */
export function findCrossComponentServiceConflicts(
  index: ProjectIndex | null,
  component: string | undefined,
  services: string[],
): ServiceConflict[] {
  if (index === null) return [];
  const name = registryComponentName(component);
  const conflicts: ServiceConflict[] = [];
  for (const entry of index.components) {
    if (entry.component === name) continue;
    for (const service of services) {
      if (entry.services.includes(service)) conflicts.push({ service, component: entry.component });
    }
  }
  return conflicts;
}
