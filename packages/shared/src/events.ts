import { z } from "zod";
import { DEPLOY_EVENT_VERSION } from "./constants";

/**
 * Append-only deploy-history record. One object per deploy under a footprint's `events/`
 * prefix (see `deployEventKey`). Advisory only — it's an audit trail + a rollback hint, and
 * is NEVER read by the reconcile loop. Holds no secret values (only image tags + the caller
 * ARN), so it's safe to keep and to print.
 */
export const DeployEventServiceSchema = z
  .object({
    service: z.string().min(1),
    image: z.string().min(1),
    /** Replicas published by this deploy (0 on an older record that didn't carry it). */
    replicas: z.number().int().min(0).default(0),
  })
  .strict();

export const DeployEventSchema = z
  .object({
    version: z.literal(DEPLOY_EVENT_VERSION),
    /** ISO timestamp the deploy completed. */
    at: z.string().min(1),
    /** The operator identity that ran it (STS caller ARN). */
    by: z.string().min(1),
    cluster: z.string().min(1),
    /** The footprint (`<project>` or `<project>-<env>`). */
    project: z.string().min(1),
    env: z.string().nullable().default(null),
    /**
     * How the deploy ran: a fresh build, a `--restart`, an `--image`/`rollback`,
     * or a placement migration (node/nodes/edge change applied by a full deploy).
     * Older CLIs reading history skip events whose kind they can't parse.
     */
    kind: z.enum(["build", "restart", "image", "migrate"]).default("build"),
    services: z.array(DeployEventServiceSchema).min(1),
    /** Convergence result, or null for a `--no-wait` deploy that didn't observe it. */
    converged: z.boolean().nullable(),
  })
  .strict();

export type DeployEventService = z.infer<typeof DeployEventServiceSchema>;
export type DeployEvent = z.infer<typeof DeployEventSchema>;
export type DeployKind = DeployEvent["kind"];

export function parseDeployEvent(input: unknown): DeployEvent {
  return DeployEventSchema.parse(input);
}

export interface BuildDeployEventInput {
  at: string;
  by: string;
  cluster: string;
  project: string;
  env?: string | undefined;
  kind: DeployKind;
  services: Array<{ service: string; image: string; replicas: number }>;
  converged: boolean | null;
}

/** Build a deterministic deploy event (services sorted by name) from a completed deploy. */
export function buildDeployEvent(input: BuildDeployEventInput): DeployEvent {
  return {
    version: DEPLOY_EVENT_VERSION,
    at: input.at,
    by: input.by,
    cluster: input.cluster,
    project: input.project,
    env: input.env ?? null,
    kind: input.kind,
    services: [...input.services]
      .map((s) => ({ service: s.service, image: s.image, replicas: s.replicas }))
      .sort((a, b) => a.service.localeCompare(b.service)),
    converged: input.converged,
  };
}
