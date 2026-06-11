#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AGENT_VERSION="${LAUNCHPAD_AGENT_VERSION:-$(node -e "const fs = require('node:fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$ROOT/packages/cli/package.json")}"
AGENT_BUNDLE="${LAUNCHPAD_AGENT_BUNDLE:-$ROOT/packages/agent/dist/index.cjs}"
PACKER_DIR="$ROOT/infra/packer"
PACKER_MANIFEST="$ROOT/infra/packer/latest-manifest.json"
CLI_MANIFEST="$ROOT/packages/cli/src/provision/golden-ami-manifest.json"

cd "$ROOT"

if ! command -v packer >/dev/null 2>&1; then
  echo "packer is required: https://developer.hashicorp.com/packer/install" >&2
  exit 1
fi

if [[ ! -f "$AGENT_BUNDLE" ]]; then
  echo "building workspace (agent bundle missing)…" >&2
  pnpm build
fi

if [[ ! -f "$AGENT_BUNDLE" ]]; then
  echo "TypeScript agent bundle not found: $AGENT_BUNDLE" >&2
  exit 1
fi

packer init "$PACKER_DIR"
packer build \
  -var "region=$REGION" \
  -var "agent_bundle_path=$AGENT_BUNDLE" \
  -var "agent_version=$AGENT_VERSION" \
  "$PACKER_DIR"

node "$ROOT/scripts/update-golden-ami-manifest.mjs" "$PACKER_MANIFEST" "$CLI_MANIFEST" "$AGENT_VERSION"
