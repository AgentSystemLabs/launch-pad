import { z } from "zod";
import type { ServiceConfig } from "./desired";

/** Env-var style secret key: uppercase letter/digit/underscore, starts with a letter. */
export const SECRET_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

export const SECRET_KEY_HINT =
  "uppercase letters, digits, and underscores (must start with a letter)";

const secretKey = z.string().regex(SECRET_KEY_REGEX, `secret key must be ${SECRET_KEY_HINT}`);

export const SecretRefSchema = z
  .object({
    name: secretKey,
    ssm: z.string().min(1),
  })
  .strict();

export type SecretRef = z.infer<typeof SecretRefSchema>;

export interface SecretPathInput {
  clusterId: string;
  ownerProject: string;
  service: string;
  key: string;
}

/** Full SSM parameter path for one service secret. */
export function secretParameterPath(input: SecretPathInput): string {
  return `${secretParameterPrefix(input)}/${input.key}`;
}

/** SSM path prefix for all secrets of one service footprint. */
export function secretParameterPrefix(input: Omit<SecretPathInput, "key">): string {
  return `/launch-pad/${input.clusterId}/${input.ownerProject}/${input.service}`;
}

/** Build wire secret refs from declared key names (deploy-time). */
export function secretRefsForService(
  secrets: readonly string[],
  input: Omit<SecretPathInput, "key">,
): SecretRef[] {
  return secrets.map((name) => ({
    name,
    ssm: secretParameterPath({ ...input, key: name }),
  }));
}

/** Keys appearing in both plain `env` and `secrets` — deploy must reject these. */
export function findEnvSecretConflicts(
  env: Record<string, string>,
  secrets: readonly string[],
): string[] {
  const envKeys = new Set(Object.keys(env));
  return secrets.filter((k) => envKeys.has(k));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

/**
 * Fingerprint of runtime config the agent stamps on containers. Uses secret ref
 * paths (not SSM values) plus plain env, restartAt, and volume mounts — so a change
 * to any of them forces the container to be replaced on the next reconcile. (Volumes
 * are config-locked and so normally never change, but stamping them is cheap defense.)
 */
export function serviceConfigStamp(config: ServiceConfig): string {
  const refs = [...(config.secretRefs ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const volumes = [...(config.volumes ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return stableJson({
    env: config.env,
    secretRefs: refs,
    restartAt: config.restartAt ?? null,
    // Omitted when empty so a volume-less service keeps its pre-volumes stamp — an
    // agent upgrade then doesn't needlessly roll every existing (volume-less) container.
    ...(volumes.length > 0 ? { volumes } : {}),
  });
}
