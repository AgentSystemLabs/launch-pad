import { hostname } from "node:os";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.type("text/plain").send(`hello from launch-pad express (${hostname()})\n`);
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, replica: hostname(), time: new Date().toISOString() });
});

const server = app.listen(port, () => {
  console.log(`web listening on :${port} (${hostname()})`);
});

function shutdown(signal) {
  console.log(`${signal} received — draining`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 25_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
