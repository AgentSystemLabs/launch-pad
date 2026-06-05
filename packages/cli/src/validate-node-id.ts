import { nodeIdError } from "@agentsystemlabs/launch-pad-shared";
import { CliError } from "./errors";

export function assertValidNodeId(name: string): void {
  const err = nodeIdError(name);
  if (err) {
    throw new CliError(`invalid node name "${name}" — ${err}`, {
      hint: "use letters, numbers, hyphens, or underscores (e.g. node-dev-1, my_app)",
    });
  }
}
