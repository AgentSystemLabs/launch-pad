import type { NodeRegistryEntry } from "@agentsystemlabs/launch-pad-shared";
import type { Ec2Observation } from "../aws/ec2";

/**
 * How a node's live EC2 state differs from what the registry intends.
 * `none` means registry and EC2 agree (including a paused node that is stopped).
 */
export type DriftClass = "none" | "stopped" | "running" | "transitional" | "gone";

/** What deploy / `node reconcile` must DO to bring a node back to "running + ready". */
export type DriftAction =
  | { kind: "noop" }
  /** Console started a paused node — adopt EC2 reality into the registry (no EC2 mutation). */
  | { kind: "sync"; publicIp: string | null; privateIp: string | null; availabilityZone: string | null }
  /** Instance exists but is stopped — start it and flip registry state to ready. */
  | { kind: "resume" }
  /** Instance is gone — replace it under the same node identity (reuse SG/EIP/profile). */
  | { kind: "recreate" }
  /** Can't safely repair right now (transitional, or gone with recreate disallowed). */
  | { kind: "blocked"; reason: string };

export interface NodeDrift {
  drift: DriftClass;
  action: DriftAction;
}

/**
 * Decide, from a node's registry entry and one EC2 observation, the single action
 * that brings it to "running + ready". Pure (no AWS), so the whole registry-state ×
 * EC2-observation matrix unit-tests without mocks.
 *
 * Registry `state` is treated as intent, not liveness: only `stopped` signals an
 * intentional pause; `ready`/`provisioning` (and anything else) mean "should be up".
 * See docs/node-ec2-drift-plan.md.
 */
export function planNodeDrift(
  entry: Pick<NodeRegistryEntry, "state">,
  ec2: Ec2Observation,
  opts: { allowRecreate: boolean },
): NodeDrift {
  const intentionallyPaused = entry.state === "stopped";

  switch (ec2.kind) {
    case "running":
      // Registry says paused but it's running → the console started it; adopt reality.
      return intentionallyPaused
        ? {
            drift: "running",
            action: {
              kind: "sync",
              publicIp: ec2.publicIp,
              privateIp: ec2.privateIp,
              availabilityZone: ec2.availabilityZone,
            },
          }
        : { drift: "none", action: { kind: "noop" } };

    case "stopped":
      // Paused + actually stopped → consistent (deploy still starts it back up).
      // Expected-up + stopped → the console stopped it (drift); start it back up.
      return intentionallyPaused
        ? { drift: "none", action: { kind: "resume" } }
        : { drift: "stopped", action: { kind: "resume" } };

    case "transitional":
      return {
        drift: "transitional",
        action: { kind: "blocked", reason: `instance is ${ec2.state}, not stable yet` },
      };

    case "missing":
      return opts.allowRecreate
        ? { drift: "gone", action: { kind: "recreate" } }
        : {
            drift: "gone",
            action: {
              kind: "blocked",
              reason: "instance is gone (terminated, or credentials point at another account/region)",
            },
          };
  }
}
