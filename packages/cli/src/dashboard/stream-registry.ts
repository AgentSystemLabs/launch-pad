/**
 * Ref-counted realtime "rooms": one shared CLI subprocess per (cluster, resource),
 * never one per viewer. Two tabs viewing the same node's monitor share a single
 * `node monitor --watch` subprocess; the last viewer to leave tears it down.
 *
 * A room owns a bounded ring buffer (what pages render) and notifies per-room
 * subscribers (SSE connections) after every push/close via `subscribeRoom`.
 */
import type { StreamHandle } from "./cli-driver";

interface Room<T> {
  key: string;
  handle: StreamHandle;
  refs: number;
  buffer: T[];
  max: number;
  closed: { code: number; stderr: string } | null;
  listeners: Set<() => void>;
}

const rooms = new Map<string, Room<unknown>>();

/**
 * Hard cap on the number of simultaneously-live rooms. Each new room spawns a shared
 * CLI subprocess (an AWS/SSM call), and room keys are derived from request path params
 * that only have to pass a loose `[A-Za-z0-9._-]` filter — they need NOT name a resource
 * that exists. Without a ceiling, a client could open many SSE connections with distinct
 * `cluster`/`node`/`service` strings and spawn an unbounded number of subprocesses,
 * exhausting PIDs/CPU/memory on the dashboard host. Existing viewers of already-live
 * rooms are unaffected (they just increment a ref count).
 */
export const MAX_LIVE_ROOMS = 64;

/** Thrown by {@link joinRoom} when opening a NEW room would exceed {@link MAX_LIVE_ROOMS}. */
export class RoomCapExceededError extends Error {
  constructor() {
    super("dashboard live-stream capacity reached");
    this.name = "RoomCapExceededError";
  }
}

export interface RoomSpec<T> {
  /** unique room id, e.g. `monitor:<cluster>:<node>` */
  key: string;
  /** ring-buffer cap (default 500) */
  max?: number;
  /**
   * Start the underlying stream. Called once, on first join. `push` appends an
   * item to the buffer and notifies listeners; `onClose` records terminal state
   * and notifies so the UI can show "stream ended".
   */
  start: (
    push: (item: T) => void,
    onClose: (info: { code: number; stderr: string }) => void,
  ) => StreamHandle;
}

/** Join (or create) a room and increment its ref count. */
export function joinRoom<T>(spec: RoomSpec<T>): { closed: { code: number; stderr: string } | null } {
  let room = rooms.get(spec.key) as Room<T> | undefined;
  if (!room) {
    // Only NEW rooms are gated — joining an existing room is always allowed so live
    // viewers never get evicted by an attacker cycling through bogus keys.
    if (rooms.size >= MAX_LIVE_ROOMS) throw new RoomCapExceededError();
    const created: Room<T> = {
      key: spec.key,
      refs: 0,
      buffer: [],
      max: spec.max ?? 500,
      closed: null,
      listeners: new Set(),
      handle: { stop: () => {} },
    };
    const notify = () => {
      for (const listener of created.listeners) listener();
    };
    const push = (item: T) => {
      created.buffer.push(item);
      while (created.buffer.length > created.max) created.buffer.shift();
      notify();
    };
    const onClose = (info: { code: number; stderr: string }) => {
      created.closed = info;
      notify();
    };
    created.handle = spec.start(push, onClose);
    rooms.set(spec.key, created as Room<unknown>);
    room = created;
  }
  room.refs++;
  return { closed: room.closed };
}

/** Decrement a room's ref count; stop + delete it when it hits zero. */
export function leaveRoom(key: string): void {
  const room = rooms.get(key);
  if (!room) return;
  room.refs--;
  if (room.refs <= 0) {
    try {
      room.handle.stop();
    } catch {
      /* gone */
    }
    rooms.delete(key);
  }
}

/**
 * Subscribe to a live room's updates (fired after every buffered item / close).
 * Returns an unsubscribe function. The caller must hold a join ref for the room's
 * lifetime — subscribing does not count as a ref.
 */
export function subscribeRoom(key: string, listener: () => void): () => void {
  const room = rooms.get(key);
  if (!room) return () => {};
  room.listeners.add(listener);
  return () => {
    room.listeners.delete(listener);
  };
}

/** Current ring buffer for a room (empty if the room isn't live). */
export function getRoomBuffer<T>(key: string): T[] {
  return (rooms.get(key)?.buffer as T[] | undefined) ?? [];
}

/** Terminal state for a room, if its subprocess exited on its own. */
export function getRoomClosed(key: string): { code: number; stderr: string } | null {
  return rooms.get(key)?.closed ?? null;
}

export function roomExists(key: string): boolean {
  return rooms.has(key);
}

/** Stop every room — wired to process exit so no CLI subprocess is orphaned. */
export function stopAllRooms(): void {
  for (const room of rooms.values()) {
    try {
      room.handle.stop();
    } catch {
      /* gone */
    }
  }
  rooms.clear();
}

let cleanupWired = false;
/** Idempotently install process-exit handlers that reap all rooms. */
export function wireRoomCleanup(): void {
  if (cleanupWired) return;
  cleanupWired = true;
  const bye = () => stopAllRooms();
  process.on("exit", bye);
  process.on("SIGINT", () => {
    bye();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bye();
    process.exit(0);
  });
}

/** Room key conventions. */
export function monitorRoomKey(cluster: string, node: string): string {
  return `monitor:${cluster}:${node}`;
}

export function logsRoomKey(cluster: string, project: string, service: string): string {
  return `logs:${cluster}:${project}/${service}`;
}
