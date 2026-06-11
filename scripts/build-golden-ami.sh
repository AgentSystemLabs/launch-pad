#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AGENT_VERSION="${LAUNCHPAD_AGENT_VERSION:-$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$ROOT/packages/cli/package.json")}"
RUST_TARGET="${LAUNCHPAD_RUST_TARGET:-x86_64-unknown-linux-musl}"
AGENT_BINARY="${LAUNCHPAD_RUST_AGENT_BINARY:-$ROOT/packages/agent-rust/target/$RUST_TARGET/release/launch-pad-agent}"
PACKER_DIR="$ROOT/infra/packer"
PACKER_MANIFEST="$ROOT/infra/packer/latest-manifest.json"
CLI_MANIFEST="$ROOT/packages/cli/src/provision/golden-ami-manifest.json"

cd "$ROOT"

if ! command -v packer >/dev/null 2>&1; then
  echo "packer is required: https://developer.hashicorp.com/packer/install" >&2
  exit 1
fi

if [[ -z "${LAUNCHPAD_RUST_AGENT_BINARY:-}" ]]; then
  if ! command -v cargo-zigbuild >/dev/null 2>&1; then
    echo "cargo-zigbuild is required to build $RUST_TARGET. Install with: cargo install cargo-zigbuild" >&2
    exit 1
  fi
  (cd "$ROOT/packages/agent-rust" && cargo zigbuild --release --target "$RUST_TARGET")
fi

if [[ ! -x "$AGENT_BINARY" ]]; then
  echo "Rust agent binary not found or not executable: $AGENT_BINARY" >&2
  exit 1
fi

packer init "$PACKER_DIR"
packer build \
  -var "region=$REGION" \
  -var "agent_binary_path=$AGENT_BINARY" \
  -var "agent_version=$AGENT_VERSION" \
  "$PACKER_DIR"

node "$ROOT/scripts/update-golden-ami-manifest.mjs" "$PACKER_MANIFEST" "$CLI_MANIFEST" "$AGENT_VERSION"
