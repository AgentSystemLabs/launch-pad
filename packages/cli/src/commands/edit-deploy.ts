import type { GlobalOpts } from "../globals";
import { type DeployOptions, runDeploy } from "./deploy";

/**
 * Flags shared by the edit-then-deploy commands (`scale`, `config`): they mutate a
 * single service's launch-pad.toml then re-run deploy for just that service so the
 * change rolls out through the normal capacity/lock/convergence path.
 */
export interface EditDeployOptions extends GlobalOpts {
  /** commander sets this false for `--no-deploy` (these commands deploy by default). */
  deploy?: boolean;
  yes?: boolean;
  /** commander sets this false for `--no-wait`. */
  wait?: boolean;
  timeout?: string;
}

/** Forward only the global/AWS-target + deploy-relevant flags to a single-service deploy. */
export function deployOptionsForEdit(service: string, opts: EditDeployOptions): DeployOptions {
  return {
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.region !== undefined ? { region: opts.region } : {}),
    ...(opts.cluster !== undefined ? { cluster: opts.cluster } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
    service,
    ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
  };
}

/** Re-run deploy for a single service after an allowlisted launch-pad.toml edit. */
export async function runEditDeploy(service: string, opts: EditDeployOptions): Promise<void> {
  await runDeploy(deployOptionsForEdit(service, opts));
}
