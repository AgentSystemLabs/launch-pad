/** Tiny UI helpers shared by action handlers (kept out of components to avoid import cycles). */
import type { AppCtx } from "../index";

/** Set a transient per-connection notice and re-render the notice slot for this socket. */
export function flash(
  ctx: AppCtx,
  invalidate: (key: string) => void,
  kind: "error" | "success",
  text: string,
): void {
  ctx.notice = { kind, text };
  invalidate("notice");
}

/** Clear the notice and re-render the slot. */
export function clearFlash(ctx: AppCtx, invalidate: (key: string) => void): void {
  ctx.notice = null;
  invalidate("notice");
}
