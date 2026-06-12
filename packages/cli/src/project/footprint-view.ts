import {
  DEFAULT_COMPONENT,
  envProject,
  isPreviewExpired,
  type PreviewMarker,
  type ProjectIndex,
} from "@agentsystemlabs/launch-pad-shared";
import type { NodeDesiredState } from "../deploy/deployed-footprint";

/** One service in a footprint, aggregated across nodes from desired.json. */
export interface FootprintServiceSummary {
  service: string;
  replicas: number;
  image: string;
  domain: string | null;
  cron?: string;
  nodeIds: string[];
}

/** Marker metadata plus the env's scheduled services (from desired.json). */
export interface FootprintEnvSummary {
  marker: PreviewMarker;
  expired: boolean;
  services: FootprintServiceSummary[];
}

/** One deployable footprint in a cluster (base prod or a named env). */
export interface FootprintListEntry {
  /** Footprint owner as it appears in desired.json (`<project>` or `<project>-<env>`). */
  owner: string;
  /** Base project name from launch-pad.toml. */
  baseProject: string;
  /** Component within the project (federated deploys), or null when unknown / whole-project. */
  component: string | null;
  /** Named environment label, or null for the base footprint. */
  env: string | null;
  marker: PreviewMarker | null;
  expired: boolean;
  services: FootprintServiceSummary[];
  nodeIds: string[];
}

export function describeEnvMarker(m: PreviewMarker, nowMs: number): string {
  const expiry =
    m.expiresAt === null
      ? "no TTL"
      : isPreviewExpired(m, nowMs)
        ? `EXPIRED ${m.expiresAt}`
        : `expires ${m.expiresAt}`;
  return `${m.project} · env ${m.env} · ${expiry}`;
}

/** Aggregate one footprint's services across nodes. Pure. */
export function summarizeFootprintServices(
  states: NodeDesiredState[],
  ownerProject: string,
): FootprintServiceSummary[] {
  const byService = new Map<string, FootprintServiceSummary>();

  for (const { nodeId, services } of states) {
    for (const s of services) {
      if (s.project !== ownerProject) continue;

      const existing = byService.get(s.service);
      if (!existing) {
        byService.set(s.service, {
          service: s.service,
          replicas: s.replicas,
          image: s.image,
          domain: s.ingress?.domain ?? null,
          nodeIds: [nodeId],
          ...(s.cron !== undefined ? { cron: s.cron } : {}),
        });
        continue;
      }

      existing.replicas += s.replicas;
      if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId);
    }
  }

  return [...byService.values()]
    .map((s) => ({ ...s, nodeIds: [...s.nodeIds].sort() }))
    .sort((a, b) => a.service.localeCompare(b.service));
}

/** Join env markers with each footprint's published placement. Pure. */
export function buildEnvFootprintSummaries(
  markers: PreviewMarker[],
  states: NodeDesiredState[],
  nowMs: number,
): FootprintEnvSummary[] {
  return [...markers]
    .sort((a, b) => `${a.project}/${a.env}`.localeCompare(`${b.project}/${b.env}`))
    .map((marker) => ({
      marker,
      expired: isPreviewExpired(marker, nowMs),
      services: summarizeFootprintServices(states, marker.owner),
    }));
}

/**
 * Discover every footprint with published services and/or an env marker. Pure.
 * Component indexes (when provided) join derived owners like `shop--auth` back
 * to their logical (project, component) so listings group by product, not by
 * owner string; owners with no marker and no index entry render as themselves
 * (legacy single-footprint projects).
 */
export function buildFootprintList(
  markers: PreviewMarker[],
  states: NodeDesiredState[],
  nowMs: number,
  indexes: ProjectIndex[] = [],
): FootprintListEntry[] {
  const markerByOwner = new Map(markers.map((m) => [m.owner, m]));
  const componentByOwner = new Map<string, { project: string; component: string }>();
  for (const idx of indexes) {
    for (const c of idx.components) componentByOwner.set(c.owner, { project: idx.project, component: c.component });
  }
  const owners = new Set<string>();
  for (const { services } of states) {
    for (const s of services) owners.add(s.project);
  }
  for (const m of markers) owners.add(m.owner);

  return [...owners]
    .map((owner) => {
      const marker = markerByOwner.get(owner) ?? null;
      const indexed = componentByOwner.get(owner) ?? null;
      const services = summarizeFootprintServices(states, owner);
      return {
        owner,
        baseProject: marker?.project ?? indexed?.project ?? owner,
        component: marker?.component ?? indexed?.component ?? null,
        env: marker?.env ?? null,
        marker,
        expired: marker ? isPreviewExpired(marker, nowMs) : false,
        services,
        nodeIds: [...new Set(services.flatMap((s) => s.nodeIds))].sort(),
      };
    })
    .sort((a, b) => {
      const byProject = a.baseProject.localeCompare(b.baseProject);
      if (byProject !== 0) return byProject;
      const byComponent = (a.component ?? "").localeCompare(b.component ?? "");
      if (byComponent !== 0) return byComponent;
      if (a.env === null && b.env !== null) return -1;
      if (a.env !== null && b.env === null) return 1;
      return (a.env ?? "").localeCompare(b.env ?? "");
    });
}

/** Resolve the S3/desired.json footprint owner for a base project + optional env. Pure. */
export function resolveFootprintOwner(baseProject: string, env: string | undefined): string {
  return envProject(baseProject, env);
}

/** One component's slice of a logical project, env-projected. */
export interface ProjectComponentView {
  component: string;
  /** The owner actually summarized (`<base owner>` or `<base owner>-<env>`). */
  owner: string;
  services: FootprintServiceSummary[];
  nodeIds: string[];
}

/**
 * Aggregate a logical project across its registered components (the federation
 * view behind `project show`). Each component's BASE owner from the index is
 * env-projected, then summarized from desired.json. Pure.
 */
export function buildProjectComponentViews(
  index: ProjectIndex,
  states: NodeDesiredState[],
  env: string | undefined,
): ProjectComponentView[] {
  return index.components.map((entry) => {
    const owner = envProject(entry.owner, env);
    const services = summarizeFootprintServices(states, owner);
    return {
      component: entry.component,
      owner,
      services,
      nodeIds: [...new Set(services.flatMap((s) => s.nodeIds))].sort(),
    };
  });
}

/** Display name for a component ("default" renders as the project itself). */
export function componentDisplayName(component: string): string | null {
  return component === DEFAULT_COMPONENT ? null : component;
}
