import type { AppCtx } from "./ctx.ts";
import type { AgentStatus } from "../db/queries.ts";

/** Human-friendly relative time from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const STATUS_CLASS: Record<string, string> = {
  working: "badge-info",
  done: "badge-success",
  idle: "badge-ghost",
  sleeping: "badge-ghost",
  paused: "badge-warning",
};

export function statusBadge(status: AgentStatus | string) {
  const cls = STATUS_CLASS[status] ?? "badge-ghost";
  return <span class={`badge ${cls} badge-sm`}>{status}</span>;
}

const EVENT_CLASS: Record<string, string> = {
  working: "border-info",
  done: "border-success",
  boot: "border-primary",
  system: "border-secondary",
  stdout: "border-base-300",
};

export function eventBorder(event: string): string {
  return EVENT_CLASS[event] ?? "border-base-300";
}

/** Set a transient flash banner for this connection and refresh the notice slot. */
export function flash(
  ctx: AppCtx,
  invalidate: (key: string) => void,
  kind: "error" | "success",
  text: string,
): void {
  ctx.notice = { kind, text };
  invalidate("notice");
}
