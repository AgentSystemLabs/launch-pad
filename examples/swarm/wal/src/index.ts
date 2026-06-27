/**
 * Swarm control-plane server: Bun + @orbital-js/station operator UI on top of
 * a single SQLite database, with a REST API mounted on the same Hono app for
 * agents (workers) and the MCP server.
 *
 *   Operator UI (WebSocket morph): /  /timeline  /agents/:id
 *   REST API (agents + curl):      /control /mission /run /wal /agents /locks
 */
import { Station } from "@orbital-js/station";
import { serveStatic } from "hono/bun";
import { openDatabase } from "./db/migrate.ts";
import { pruneOldStdout } from "./db/queries.ts";
import { createApiApp, type ChangeEvent, type Notify } from "./api/routes.ts";
import { initialCtx, type AppCtx } from "./lib/ctx.ts";
import { registerLayout } from "./pages/layout.tsx";
import { registerDashboard } from "./pages/dashboard.tsx";
import { registerWal } from "./pages/wal.tsx";
import { registerAgent } from "./pages/agent.tsx";

const DATA_DIR = process.env.WAL_DATA_DIR ?? "/data";
const DB_PATH = process.env.SWARM_DB ?? `${DATA_DIR}/swarm.db`;
const PORT = Number(process.env.PORT ?? 8080);
const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN ?? "";

const db = openDatabase(DB_PATH);

const station = new Station<AppCtx>({
  styles: ["/styles.css"],
  port: PORT,
  hostname: process.env.WAL_HOST, // undefined ⇒ bind all interfaces (in-cluster)
  routes: [
    { path: "/", target: "content", template: "dashboard" },
    { path: "/timeline", target: "content", template: "wal" },
    { path: "/agents/:id", target: "content", template: "agent-detail" },
  ],
});

/**
 * Map a coarse change event (from REST mutations or operator actions) to the
 * Station broadcast keys that re-render the affected live regions.
 */
const notify: Notify = (e: ChangeEvent) => {
  switch (e.kind) {
    case "control":
      station.broadcast("control-bar");
      station.broadcast("mission-panel");
      station.broadcast("agents-grid");
      break;
    case "mission":
      station.broadcast("mission-panel");
      break;
    case "wal":
      station.broadcast("wal-feed");
      break;
    case "agents":
      station.broadcast("agents-grid");
      station.broadcast("agent-task");
      break;
    case "stdout":
      station.broadcast("agent-stdout", (ctx) => ctx.viewingAgent === e.agent);
      break;
  }
};

// Operator-only actions gated by the shared token (when configured).
const OPERATOR_ACTIONS = new Set([
  "mission:draft",
  "swarm:run",
  "swarm:pause",
  "swarm:resume",
]);

station.onConnect((req) => {
  const ctx = initialCtx();
  if (!OPERATOR_TOKEN) {
    ctx.authed = true;
  } else {
    try {
      const url = new URL(req.url);
      const tok = url.searchParams.get("token") ?? req.headers.get("x-operator-token");
      ctx.authed = tok === OPERATOR_TOKEN;
    } catch {
      ctx.authed = false;
    }
  }
  return ctx;
});

station.beforeAction((ctx, key) => {
  if (OPERATOR_TOKEN && OPERATOR_ACTIONS.has(key) && !ctx.authed) {
    return "operator token required";
  }
  return true;
});

// Register UI templates + actions.
registerLayout(station, db);
registerDashboard(station, db, notify);
registerWal(station, db);
registerAgent(station, db);

// Mount the REST API + static styles on the Station Hono app. Cast across the
// boundary: orbital-js and this package each resolve their own copy of `hono`,
// so the Hono types are nominally distinct though runtime-identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = station.getApp() as any;
app.use("/styles.css", serveStatic({ path: "./dist/styles.css" }));
createApiApp(db, { app, notify, operatorToken: OPERATOR_TOKEN });

// Periodic stdout retention sweep (per-agent byte cap is enforced on append; this
// drops anything older than the time window across all agents).
const RETENTION_DAYS = Number(process.env.STDOUT_RETENTION_DAYS ?? 3);
if (RETENTION_DAYS > 0) {
  setInterval(
    () => {
      try {
        const dropped = pruneOldStdout(db, RETENTION_DAYS * 86_400_000);
        if (dropped > 0) console.log(`[swarm-wal] pruned ${dropped} stdout rows older than ${RETENTION_DAYS}d`);
      } catch (err) {
        console.error("[swarm-wal] retention sweep failed:", err);
      }
    },
    60 * 60 * 1000,
  );
}

await station.listen();
console.log(`[swarm-wal] db=${DB_PATH} port=${PORT}${OPERATOR_TOKEN ? " (operator token enabled)" : ""}`);
