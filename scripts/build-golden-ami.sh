#!/usr/bin/env bash
# Build role + architecture-specific golden AMIs and write their ids into the
# CLI's committed manifest. Pass `edge` or `app` as $1 to build just one role.
# Set LAUNCHPAD_AMI_ARCH=x86_64|arm64 to build one architecture; default builds both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AGENT_VERSION="${LAUNCHPAD_AGENT_VERSION:-$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$ROOT/packages/cli/package.json")}"
DIST="$ROOT/packages/agent-rust/dist"
PACKER_DIR="$ROOT/infra/packer"
CLI_MANIFEST="$ROOT/packages/cli/src/provision/golden-ami-manifest.json"
ROLES=("${1:-edge}")
if [[ $# -eq 0 ]]; then ROLES=(edge app); fi
if [[ -n "${LAUNCHPAD_AMI_ARCH:-}" ]]; then
  ARCHES=("$LAUNCHPAD_AMI_ARCH")
else
  ARCHES=(x86_64 arm64)
fi

cd "$ROOT"

if ! command -v packer >/dev/null 2>&1; then
  echo "packer is required: https://developer.hashicorp.com/packer/install" >&2
  exit 1
fi

# The AMIs bake the Rust agent binaries — build them first if missing.
if [[ ! -f "$DIST/x86_64/agent-edge" || ! -f "$DIST/x86_64/agent-app" || ! -f "$DIST/arm64/agent-edge" || ! -f "$DIST/arm64/agent-app" ]]; then
  echo "agent binaries missing — building (pnpm build:agent)…" >&2
  bash "$ROOT/scripts/build-agent-binaries.sh"
fi

for ROLE in "${ROLES[@]}"; do
  if [[ "$ROLE" != "edge" && "$ROLE" != "app" ]]; then
    echo "usage: build-golden-ami.sh [edge|app]   (no arg = both)" >&2
    exit 1
  fi
  for ARCH in "${ARCHES[@]}"; do
    if [[ "$ARCH" != "x86_64" && "$ARCH" != "arm64" ]]; then
      echo "LAUNCHPAD_AMI_ARCH must be x86_64 or arm64" >&2
      exit 1
    fi
    TEMPLATE="$PACKER_DIR/golden-ami-$ROLE.pkr.hcl"
    PACKER_MANIFEST="$PACKER_DIR/latest-manifest-$ROLE.json"

    echo "building $ROLE $ARCH golden AMI in $REGION…"
    packer init "$TEMPLATE"
    packer build \
      -var "region=$REGION" \
      -var "architecture=$ARCH" \
      -var "agent_binary_path=$DIST/$ARCH/agent-$ROLE" \
      -var "agent_version=$AGENT_VERSION" \
      "$TEMPLATE"

    node "$ROOT/scripts/update-golden-ami-manifest.mjs" "$PACKER_MANIFEST" "$CLI_MANIFEST" "$AGENT_VERSION" "$ROLE" "$ARCH"
  done
done
