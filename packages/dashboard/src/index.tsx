import { Station } from "@orbital-js/station";
import { serveStatic } from "hono/bun";

import { loadConfig } from "./lib/app-config";
import { wireRoomCleanup } from "./lib/stream-registry";
import { leaveCtxRooms } from "./lib/rooms";
import { registerLayout } from "./components/layout";
import { registerClusters } from "./pages/clusters";
import { registerNodes } from "./pages/nodes";
import { registerProjects } from "./pages/projects";
import { registerServices } from "./pages/services";
import { registerMonitor } from "./pages/monitor";
import { registerLogs } from "./pages/logs";

/** Per-connection state. AWS truth is read live via the CLI; this is just routing + UI. */
export type AppCtx = {
  /** active cluster — used by the Clusters page actions and as the default for new work */
  cluster: string;
  profile?: string;
  region?: string;
  /** realtime room bookkeeping — set on a page's p-load, cleared on leave/disconnect */
  liveMonitor?: { cluster: string; node: string };
  liveLogs?: { cluster: string; project: string; service: string };
  /** which project's env is open in the inline editor (Projects page) */
  editing?: { project: string; dir: string } | null;
  /** transient per-connection feedback rendered into a notice slot */
  notice?: { kind: "error" | "success"; text: string } | null;
};

export const station = new Station<AppCtx>({
  styles: ["/styles.css"],
  port: Number(process.env.PORT ?? 4000),
  hostname: process.env.LAUNCH_PAD_DASHBOARD_HOST ?? "127.0.0.1",
  routes: [
    { path: "/", target: "content", template: "clusters" },
    { path: "/projects", target: "content", template: "projects" },
    { path: "/clusters/:cluster/nodes", target: "content", template: "nodes" },
    { path: "/clusters/:cluster/services", target: "content", template: "services" },
    { path: "/clusters/:cluster/nodes/:node/monitor", target: "content", template: "monitor" },
    { path: "/clusters/:cluster/logs/:project/:service", target: "content", template: "logs" },
  ],
});

station.onConnect(() => {
  const cfg = loadConfig();
  return {
    cluster: cfg.defaultCluster ?? "default",
    profile: cfg.profile,
    region: cfg.region,
    notice: null,
  };
});

// When a socket drops, leave any realtime room it had joined so the shared
// CLI subprocess is torn down once its last viewer is gone.
station.onDisconnect((ctx) => leaveCtxRooms(ctx));

station.onError((err, kind) => {
  console.error(`[station:${kind}]`, err instanceof Error ? err.message : err);
});

registerLayout(station);
registerClusters(station);
registerNodes(station);
registerProjects(station);
registerServices(station);
registerMonitor(station);
registerLogs(station);

// `as never`: station is file:-linked and carries its own Hono types, so the
// middleware from this package's hono doesn't structurally match getApp()'s
// param type. It's the same hono at runtime (the example app mounts it the same way).
station.getApp().use("/styles.css", serveStatic({ path: "./dist/styles.css" }) as never);

wireRoomCleanup();

const { port } = await station.listen();
console.log(`launch-pad dashboard → http://127.0.0.1:${port}`);
