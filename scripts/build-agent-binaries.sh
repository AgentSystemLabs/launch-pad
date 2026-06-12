#!/usr/bin/env bash
# Cross-compile the Rust node agent into the linux/amd64 binaries the CLI
# distributes (uploaded to S3 at provision/upgrade time, baked into golden AMIs).
#
# Output: packages/agent-rust/dist/agent-edge + packages/agent-rust/dist/agent-app
# (static musl builds — no glibc version coupling with the AMI).
#
# Requires: rustup toolchain, the x86_64-unknown-linux-musl target, and
# cargo-zigbuild (+ zig) for cross-linking from macOS/non-linux hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/packages/agent-rust"
DIST="$CRATE/dist"
TARGET="x86_64-unknown-linux-musl"

if ! command -v cargo >/dev/null; then
  echo "error: cargo not found — install Rust via rustup (https://rustup.rs)" >&2
  exit 1
fi

BUILD=(cargo build)
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  : # native build links fine
elif command -v cargo-zigbuild >/dev/null; then
  BUILD=(cargo zigbuild)
else
  echo "error: cross-compiling to $TARGET needs cargo-zigbuild (cargo install cargo-zigbuild; brew install zig)" >&2
  exit 1
fi

if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "installing rust target $TARGET…"
  rustup target add "$TARGET"
fi

cd "$CRATE"
echo "building edge agent ($TARGET, release)…"
"${BUILD[@]}" --release --target "$TARGET" --no-default-features --features edge --bin launchpad-agent-edge
echo "building app agent ($TARGET, release)…"
"${BUILD[@]}" --release --target "$TARGET" --no-default-features --features app --bin launchpad-agent-app

mkdir -p "$DIST"
cp "target/$TARGET/release/launchpad-agent-edge" "$DIST/agent-edge"
cp "target/$TARGET/release/launchpad-agent-app" "$DIST/agent-app"

echo
echo "agent binaries ready:"
ls -lh "$DIST" | awk 'NR>1 {print "  " $9 "  " $5}'
