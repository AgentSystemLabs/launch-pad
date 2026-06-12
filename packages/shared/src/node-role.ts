import { z } from "zod";
import type { NodeRole } from "./registry";

/** New provisions only — legacy `both` is read from existing node.json, never created. */
export const ProvisionNodeRoleSchema = z.enum(["app", "edge"]);
export type ProvisionNodeRole = z.infer<typeof ProvisionNodeRoleSchema>;

/** True when the node runs app containers (`app` or legacy `both`). */
export function nodeHostsContainers(role: NodeRole): boolean {
  return role === "app" || role === "both";
}

/** True when the node terminates TLS / routes ingress (`edge` or legacy `both`). */
export function nodeFrontsIngress(role: NodeRole): boolean {
  return role === "edge" || role === "both";
}
