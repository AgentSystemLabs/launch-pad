import { hostname } from "node:os";
import express from "express";

// Bump RELEASE and re-deploy to watch a zero-downtime rolling update.
const RELEASE = "v2";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.type("text/plain").send(`hello world from launch-pad (${RELEASE}) — replica ${hostname()}\n`);
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, release: RELEASE, replica: hostname(), time: new Date().toISOString() });
});

const server = app.listen(port, () => {
  console.log(`web ${RELEASE} listening on :${port} (${hostname()})`);
});

// Graceful shutdown: stop accepting connections and let in-flight requests finish
// before exiting, so a rolling update drains cleanly.
function shutdown(signal) {
  console.log(`${signal} received — draining`);
  server.close(() => {
    console.log("closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("drain timed out — forcing exit");
    process.exit(0);
  }, 25_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
