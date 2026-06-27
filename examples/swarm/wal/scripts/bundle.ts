/**
 * Build a self-contained server bundle for the container image.
 *
 * Why this exists: @orbital-js/station reads its browser client script from
 * `path.join(__dirname, "./station.js")` at runtime. `bun build` bakes that
 * module's BUILD-TIME absolute directory into the bundle, so the read points at
 * the host's orbital-js checkout — which doesn't exist in the image. We bundle,
 * copy station.js next to the bundle, then rewrite the baked station source dir
 * (extracted from the bundle itself, the source of truth) to the container's
 * dist dir (`/app/dist`). The bundle is container-only (local dev/tests run from
 * source), so hardcoding the container path is safe.
 */
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

const OUT_DIR = "dist";
const CONTAINER_DIST = "/app/dist";

// 1. Bundle the server (inlines orbital-js + hono; bun:* stays external).
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "bun",
  outdir: OUT_DIR,
  naming: "server.js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle failed");
}

// 2. Copy the station client script next to the bundle (deref the symlink).
const stationJs = realpathSync("node_modules/@orbital-js/station/src/station.js");
await Bun.write(`${OUT_DIR}/station.js`, Bun.file(stationJs));

// 3. Rewrite every baked absolute station-source dir → the container dist dir.
//    Extract the literal(s) from the bundle so we match whatever bun baked
//    (the symlink target path), regardless of host layout.
const serverPath = `${OUT_DIR}/server.js`;
let src = await Bun.file(serverPath).text();
const bakedDirs = new Set<string>([dirname(stationJs)]);
for (const m of src.matchAll(/["'`](\/[^"'`]*?\/station\/src)["'`]/g)) {
  if (m[1]) bakedDirs.add(m[1]);
}
for (const dir of bakedDirs) src = src.replaceAll(dir, CONTAINER_DIST);
await Bun.write(serverPath, src);

const leftovers = [...src.matchAll(/["'`](\/[^"'`]*?\/station\/src)["'`]/g)].map((m) => m[1]);
console.log(
  `bundled ${serverPath} (${(src.length / 1024) | 0} KB); rewrote [${[...bakedDirs].join(", ")}] → ${CONTAINER_DIST}; leftovers=${leftovers.length}`,
);
if (leftovers.length) throw new Error(`baked station path remains: ${leftovers.join(", ")}`);
