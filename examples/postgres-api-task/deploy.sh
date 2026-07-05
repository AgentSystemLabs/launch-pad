#!/usr/bin/env bash
set -euo pipefail

CLUSTER="${LAUNCHPAD_CLUSTER:-lp-db-test}"
LAUNCHPAD_BIN="${LAUNCHPAD_BIN:-launchpad}"

echo "Deploying database service..."
"$LAUNCHPAD_BIN" deploy --cluster "$CLUSTER" --service primary --yes

echo "Running migrations..."
"$LAUNCHPAD_BIN" job run migrate --cluster "$CLUSTER" --wait --yes

echo "Deploying API service..."
"$LAUNCHPAD_BIN" deploy --cluster "$CLUSTER" --service api --yes

echo "Verifying DNS..."
"$LAUNCHPAD_BIN" dns verify api.lp-db-test.webdevcody.com --cluster "$CLUSTER"

echo "Checking API..."
curl -fsS https://api.lp-db-test.webdevcody.com/healthz
curl -fsS https://api.lp-db-test.webdevcody.com/db
echo
