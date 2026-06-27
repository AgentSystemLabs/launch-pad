# syntax=docker/dockerfile:1
#
# The WAL control plane is a Bun + @orbital-js/station app. orbital-js lives in a
# sibling repo OUTSIDE this build context, so it can't be `bun install`ed here.
# Instead the server is pre-bundled on the host (`bun run build`) into a single
# self-contained file plus the station client script and compiled CSS:
#
#     cd examples/swarm/wal && bun install && bun run build
#
# That produces dist/{server.js,station.js,styles.css}, which is all the image
# needs — the Bun runtime executes the bundle directly (no node_modules).
FROM oven/bun:1-alpine
WORKDIR /app

# Fail early with a clear message if the bundle wasn't built on the host.
COPY dist ./dist
RUN test -f dist/server.js || (echo "ERROR: dist/server.js missing — run 'bun run build' in examples/swarm/wal before deploy" && exit 1)

ENV WAL_DATA_DIR=/data
ENV PORT=8080
RUN mkdir -p /data

EXPOSE 8080
CMD ["bun", "dist/server.js"]
