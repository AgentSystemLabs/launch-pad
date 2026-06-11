/**
 * An expected, user-facing error. Thrown by commands when something is wrong with
 * input, config, or AWS state. The top-level handler prints `message` (and the
 * optional `hint`) cleanly without a stack trace.
 */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, opts?: { hint?: string; exitCode?: number }) {
    super(message);
    this.name = "CliError";
    this.hint = opts?.hint;
    this.exitCode = opts?.exitCode ?? 1;
  }
}

/**
 * A rebalance/evacuation can't move a footprint off the drained node(s): a service
 * pinned to one of them is config-locked, or draining would leave the cluster with no
 * app nodes to place onto. A typed subclass so `node destroy --evacuate` can tell this
 * "nothing-could-be-moved" case apart from a real failure (config-lock drift, AWS error)
 * and fall through to its own orphan/`--force` decision instead of aborting.
 */
export class EvacuationBlockedError extends CliError {
  constructor(message: string, opts?: { hint?: string }) {
    super(message, opts);
    this.name = "EvacuationBlockedError";
  }
}
