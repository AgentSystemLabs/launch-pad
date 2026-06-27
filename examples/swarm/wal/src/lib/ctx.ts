/** Per-connection Station context for the operator UI. */
export type AppCtx = {
  /** Agent whose detail page this socket is viewing (drives stdout broadcasts). */
  viewingAgent: string | null;
  /** Selected agent filter on the WAL timeline (per-connection). */
  walFilter: string | null;
  /** Whether this connection passed the operator token gate (when enabled). */
  authed: boolean;
  /** Transient flash banner. */
  notice: { kind: "error" | "success"; text: string } | null;
};

export function initialCtx(): AppCtx {
  return { viewingAgent: null, walFilter: null, authed: false, notice: null };
}
