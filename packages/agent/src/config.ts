import { readFileSync } from "node:fs";
import { z } from "zod";

const AgentConfigSchema = z
  .object({
    nodeId: z.string().min(1),
    agentId: z.string().min(1),
    bucket: z.string().min(1),
    region: z.string().min(1),
  })
  .strict();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const DEFAULT_CONFIG_PATH = "/etc/launch-pad/agent.json";

/** Load + validate the agent config written by `node create` (env-overridable for dev). */
export function loadAgentConfig(): AgentConfig {
  const path = process.env.LAUNCHPAD_AGENT_CONFIG ?? DEFAULT_CONFIG_PATH;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return AgentConfigSchema.parse(raw);
}
