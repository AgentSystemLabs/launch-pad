/** Small presentation helpers shared across dashboard pages. Reuses shared math where it exists. */
import { sharesToVcpu, isHeartbeatStale } from "@agentsystemlabs/launch-pad-shared";

export { sharesToVcpu, isHeartbeatStale };

/** vCPU shares → "1.5 vCPU". */
export function vcpu(shares: number): string {
  return `${sharesToVcpu(shares)} vCPU`;
}

/** Megabytes → "512 MB" / "2.0 GB". */
export function mb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
}

/** Round a percentage for display. */
export function pct(value: number): string {
  return `${Math.round(value)}%`;
}

/** ISO timestamp → "3s ago" / "5m ago" / "2h ago". null-safe. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** daisyui badge class for a service / replica state. */
export function stateBadgeClass(state: string): string {
  switch (state) {
    case "running":
      return "badge-success";
    case "error":
      return "badge-error";
    case "pending":
    case "pulling":
    case "starting":
      return "badge-warning";
    case "stopping":
    case "stopped":
      return "badge-ghost";
    default:
      return "badge-ghost";
  }
}

/** daisyui badge class for an EC2 / registry node state. */
export function nodeStateBadgeClass(state: string | null | undefined): string {
  switch (state) {
    case "running":
    case "ready":
      return "badge-success";
    case "stopped":
    case "stopping":
      return "badge-warning";
    case "terminated":
    case "terminating":
      return "badge-error";
    case "provisioning":
    case "pending":
      return "badge-info";
    default:
      return "badge-ghost";
  }
}

/** progress-bar color class from a 0–100 utilization value. */
export function utilColorClass(percent: number): string {
  if (percent >= 90) return "progress-error";
  if (percent >= 70) return "progress-warning";
  return "progress-success";
}

/** First stderr line of a terminated stream, or its exit code. */
export function closedLine(closed: { code: number; stderr: string }): string {
  return closed.stderr.split("\n")[0] || `exit ${closed.code}`;
}
