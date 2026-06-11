import { nodeStateBadgeClass } from "../lib/format";

export function NodeStateBadge({ state }: { state: string }) {
  return <span class={`badge badge-sm ${nodeStateBadgeClass(state)}`}>{state}</span>;
}

/** Sample state badges explaining the State column colors on the nodes table. */
export function NodeStateLegend() {
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-70" data-testid="node-state-legend">
      <span class="opacity-60 mr-1">State badges:</span>
      <NodeStateBadge state="running" />
      <NodeStateBadge state="stopped" />
      <NodeStateBadge state="provisioning" />
      <NodeStateBadge state="terminated" />
    </div>
  );
}
