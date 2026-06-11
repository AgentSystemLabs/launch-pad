/**
 * Ref-counted realtime "rooms": one shared CLI subprocess per (cluster, resource),
 * never one per socket. Two tabs viewing the same node's monitor share a single
 * `node monitor --watch` subprocess; the last viewer to leave tears it down.
 *
 * A room owns a bounded ring buffer (the data templates render) and an `onUpdate`
 * callback the caller wires to `station.broadcast(key, filter)` so every subscribed
 * socket re-renders when a new sample/line arrives.
 */
import type { StreamHandle } from "./run-launch-pad";

interface Room<T> {
  key: string;
  handle: StreamHandle;
  refs: number;
  buffer: T[];
  max: number;
  closed: { code: number; stderr: string } | null;
  onUpdate: () => void;
}

const rooms = new Map<string, Room<unknown>>();

export interface RoomSpec<T> {
  /** unique room id, e.g. `monitor:<cluster>:<node>` */
  key: string;
  /** ring-buffer cap (default 500) */
  max?: number;
  /**
   * Start the underlying stream. Called once, on first join. `push` appends an
   * item to the buffer and fires onUpdate; `onClose` records terminal state and
   * fires onUpdate so the UI can show "stream ended".
   */
  start: (
    push: (item: T) => void,
    onClose: (info: { code: number; stderr: string }) => void,
  ) => StreamHandle;
  /** invoked after every push and on close — the caller broadcasts here */
  onUpdate: () => void;
}

/** Join (or create) a room and increment its ref count. Returns the room view. */
export function joinRoom<T>(spec: RoomSpec<T>): { closed: Room<T>["closed"] } {
  let room = rooms.get(spec.key) as Room<T> | undefined;
  if (!room) {
    const created: Room<T> = {
      key: spec.key,
      refs: 0,
      buffer: [],
      max: spec.max ?? 500,
      closed: null,
      onUpdate: spec.onUpdate,
      handle: { stop: () => {} },
    };
    const push = (item: T) => {
      created.buffer.push(item);
      while (created.buffer.length > created.max) created.buffer.shift();
      created.onUpdate();
    };
    const onClose = (info: { code: number; stderr: string }) => {
      created.closed = info;
      created.onUpdate();
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
