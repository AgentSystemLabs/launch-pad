/**
 * Bridges ref-counted rooms (shared CLI subprocesses) to SSE responses.
 *
 * Each SSE connection joins the room (one subprocess shared across viewers),
 * subscribes to its updates, and receives JSON-encoded HTML fragments the client
 * swaps into `[data-sse]` targets. Updates are coalesced (~150ms) so a burst of
 * log lines renders once, and a keepalive ping defeats idle proxy timeouts.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { joinRoom, leaveRoom, subscribeRoom, type RoomSpec } from "./stream-registry";

const COALESCE_MS = 150;
const KEEPALIVE_MS = 25_000;

export interface SseRoomOpts<T> {
  key: string;
  max?: number;
  /** starts the underlying CLI stream — only called for the first viewer */
  start: RoomSpec<T>["start"];
  /** render the room's current state (buffer + closed banner) to an HTML fragment */
  render: () => string;
}

export function sseRoomResponse<T>(c: Context, opts: SseRoomOpts<T>): Response {
  return streamSSE(c, async (stream) => {
    joinRoom<T>({ key: opts.key, max: opts.max, start: opts.start });

    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;

    const send = async () => {
      if (closed) return;
      try {
        await stream.writeSSE({ data: JSON.stringify(opts.render()) });
      } catch {
        /* connection torn down mid-write */
      }
    };

    const schedule = () => {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (dirty) {
          dirty = false;
          void send();
        }
      }, COALESCE_MS);
    };

    const unsubscribe = subscribeRoom(opts.key, schedule);
    const keepalive = setInterval(() => {
      // Never let a ping-vs-disconnect race become an unhandled rejection —
      // that would crash the whole dashboard process.
      if (!closed) stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }, KEEPALIVE_MS);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    stream.onAbort(() => {
      if (closed) return; // idempotent — a double-fire must not double-leaveRoom a shared room
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(keepalive);
      unsubscribe();
      leaveRoom(opts.key);
      release();
    });

    await send(); // initial catch-up render
    await held; // hold the response open until the client disconnects
  });
}
