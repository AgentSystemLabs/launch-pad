import { stateBadgeClass } from "../format";
import type { ReplicaStatus } from "../lp-types";

export function StateBadge({ state }: { state: string }) {
  return <span class={`badge ${stateBadgeClass(state)} badge-sm`}>{state}</span>;
}

/** A row of colored dots, one per replica: green=healthy, red=error, amber=other. */
export function ReplicaDots({ replicas }: { replicas: ReplicaStatus[] }) {
  if (!replicas || replicas.length === 0) return <span class="opacity-40 text-xs">no replicas</span>;
  return (
    <div class="flex gap-1 items-center" title={`${replicas.length} replica(s)`}>
      {replicas.map((r) => {
        const color = r.healthy ? "bg-success" : r.state === "error" ? "bg-error" : "bg-warning";
        return <span class={`inline-block w-2.5 h-2.5 rounded-full ${color}`}></span>;
      })}
    </div>
  );
}

/** Key for the per-replica dot colors shown in the services table. */
export function ReplicaLegend() {
  return (
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70" data-testid="replica-legend">
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-success" aria-hidden="true"></span>
        Healthy
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-warning" aria-hidden="true"></span>
        Transitioning
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-error" aria-hidden="true"></span>
        Error
      </span>
    </div>
  );
}

/** Sample state badges explaining the State column colors. */
export function StateLegend() {
  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-70" data-testid="state-legend">
      <span class="opacity-60 mr-1">State badges:</span>
      <StateBadge state="running" />
      <StateBadge state="starting" />
      <StateBadge state="error" />
      <StateBadge state="stopped" />
    </div>
  );
}
