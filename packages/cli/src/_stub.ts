import { log } from "./ui/log";

/** Placeholder action for commands whose implementation lands in a later milestone. */
export function notImplemented(command: string): void {
  log.warn(`\`launchpad ${command}\` isn't implemented yet — it lands in the next milestone.`);
}
