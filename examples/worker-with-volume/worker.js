import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

// A tiny worker that demonstrates a persistent volume. On every boot it appends a
// line to a file ON THE MOUNTED VOLUME, then prints the running tally. Because the
// volume survives a container replacement, the tally keeps growing across deploys /
// restarts instead of resetting to 1 — exactly what SQLite, uploads, and local caches
// need. Mount it at /data via [[service.volumes]] in launch-pad.toml.
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const LOG = `${DATA_DIR}/boot.log`;

mkdirSync(DATA_DIR, { recursive: true });
// One append per container START. Because the volume persists across container
// replacements, this count keeps growing instead of resetting to 1.
appendFileSync(LOG, `boot ${new Date().toISOString()}\n`);

function bootCount() {
  return readFileSync(LOG, "utf8").trimEnd().split("\n").length;
}

// Re-print the running tally periodically — a real app logs continuously, and the
// CloudWatch agent tails from the end, so a once-at-boot line can be missed.
function report() {
  console.log(`[worker] boot count: ${bootCount()}`);
}
report();
setInterval(report, 8000);

// Graceful drain so rolling restarts are clean.
function shutdown(signal) {
  console.log(`[worker] ${signal} received — draining`);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
