/** Realtime room key conventions + ctx teardown, shared by pages and onDisconnect. */
import { leaveRoom } from "./stream-registry";

export interface RoomCtx {
  liveMonitor?: { cluster: string; node: string };
  liveLogs?: { cluster: string; project: string; service: string };
}

export function monitorRoomKey(cluster: string, node: string): string {
  return `monitor:${cluster}:${node}`;
}

export function logsRoomKey(cluster: string, project: string, service: string): string {
  return `logs:${cluster}:${project}/${service}`;
}

/**
 * Leave whatever realtime rooms this connection had joined and clear the
 * bookkeeping. Called by stream pages before joining a new room (reset-then-join,
 * race-free) and by non-stream pages on p-load (nav teardown without disconnect).
 */
export function leaveCtxRooms(ctx: RoomCtx): void {
  if (ctx.liveMonitor) {
    leaveRoom(monitorRoomKey(ctx.liveMonitor.cluster, ctx.liveMonitor.node));
    ctx.liveMonitor = undefined;
  }
  if (ctx.liveLogs) {
    leaveRoom(logsRoomKey(ctx.liveLogs.cluster, ctx.liveLogs.project, ctx.liveLogs.service));
    ctx.liveLogs = undefined;
  }
}
