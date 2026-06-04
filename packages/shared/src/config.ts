import { z } from "zod";

/** DNS/label-safe identifier: lowercase alphanumeric + hyphen, 1–40 chars. */
export const LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

const label = (what: string) =>
  z.string().regex(LABEL_REGEX, `${what} must be lowercase letters, numbers and hyphens (1–40 chars)`);

/** One `[[service]]` block in launch-pad.toml. */
export const ServiceDeclSchema = z
  .object({
    name: label("service name"),
    node: z.string().min(1, "service.node is required"),
    dockerfile: z.string().default("./Dockerfile"),
    /** Docker build context, relative to the launch-pad.toml directory. */
    context: z.string().default("."),
    cpu: z.number().int().positive("cpu must be a positive integer (vCPU shares, 1024 = 1 vCPU)"),
    memory: z.number().int().positive("memory must be a positive integer (MB)"),
    env: z.record(z.string(), z.string()).default({}),
    domain: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict()
  .refine((s) => (s.domain === undefined) === (s.port === undefined), {
    message: "a web service needs BOTH `domain` and `port`; a worker needs NEITHER",
    path: ["domain"],
  });

/** The whole launch-pad.toml document. */
export const LaunchPadConfigSchema = z
  .object({
    project: label("project"),
    service: z.array(ServiceDeclSchema).min(1, "at least one [[service]] is required"),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.service.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate service name "${s.name}"`,
          path: ["service", i, "name"],
        });
      }
      seen.add(s.name);
    });
  });

export type ServiceDecl = z.infer<typeof ServiceDeclSchema>;
export type LaunchPadConfig = z.infer<typeof LaunchPadConfigSchema>;

/** Parse + validate a decoded TOML object. Throws ZodError on invalid input. */
export function parseLaunchPadConfig(input: unknown): LaunchPadConfig {
  return LaunchPadConfigSchema.parse(input);
}

/** True when the service declares ingress (web) rather than being a worker. */
export function isWebService(s: ServiceDecl): boolean {
  return s.domain !== undefined && s.port !== undefined;
}
