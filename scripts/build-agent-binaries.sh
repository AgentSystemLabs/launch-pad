#!/usr/bin/env bash
# Cross-compile the Rust node agent into linux binaries the CLI distributes
# (uploaded to S3 at provision/upgrade time, baked into golden AMIs).
#
# Output:
#   packages/agent-rust/dist/x86_64/agent-edge + agent-app
#   packages/agent-rust/dist/arm64/agent-edge + agent-app
# (static musl builds — no glibc version coupling with the AMI).
#
# Requires: rustup toolchain, musl targets, and
# cargo-zigbuild (+ zig) for cross-linking from macOS/non-linux hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/packages/agent-rust"
DIST="$CRATE/dist"
TARGETS=("x86_64-unknown-linux-musl:x86_64" "aarch64-unknown-linux-musl:arm64")

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
  echo "error: cross-compiling needs cargo-zigbuild (cargo install cargo-zigbuild; brew install zig)" >&2
  exit 1
fi

cd "$CRATE"
for entry in "${TARGETS[@]}"; do
  TARGET="${entry%%:*}"
  DIST_ARCH="${entry##*:}"
  if ! rustup target list --installed | grep -q "$TARGET"; then
    echo "installing rust target ${TARGET}..."
    rustup target add "$TARGET"
  fi

  echo "building edge agent (${TARGET}, release)..."
  "${BUILD[@]}" --release --target "$TARGET" --no-default-features --features edge --bin launchpad-agent-edge
  echo "building app agent (${TARGET}, release)..."
  "${BUILD[@]}" --release --target "$TARGET" --no-default-features --features app --bin launchpad-agent-app

  mkdir -p "$DIST/$DIST_ARCH"
  cp "target/$TARGET/release/launchpad-agent-edge" "$DIST/$DIST_ARCH/agent-edge"
  cp "target/$TARGET/release/launchpad-agent-app" "$DIST/$DIST_ARCH/agent-app"
done

echo
echo "agent binaries ready:"
for file in "$DIST"/*/agent-*; do
  [[ -f "$file" ]] || continue
  size="$(du -h "$file" | awk '{print $1}')"
  echo "  ${file#$DIST/}  $size"
done
