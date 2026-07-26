#!/usr/bin/env bash

set -euo pipefail

# Manual deployment script for the provisioned Deno 2 app.
# Requires the Deno CLI and DENO_DEPLOY_TOKEN.

# --- Configuration ---
PROJECT_NAME="rpc-ubq-fi"
DENO_ORG="ubiquity-dao"
DEPLOY_ROOT="packages/permit2-rpc-server"
# --- End Configuration ---

# Check if DENO_DEPLOY_TOKEN is set
if [ -z "${DENO_DEPLOY_TOKEN:-}" ]; then
  echo "Error: DENO_DEPLOY_TOKEN environment variable is not set."
  echo "Please set it before running this script."
  exit 1
fi

echo "Deploying Deno 2 app '$PROJECT_NAME' from '$DEPLOY_ROOT'..."

# The app is provisioned with src/deno-server.ts as its Deno 2 entrypoint.
deno deploy \
  --org="$DENO_ORG" \
  --app="$PROJECT_NAME" \
  --prod \
  --non-interactive \
  "$DEPLOY_ROOT"

echo "Deployment command executed."
echo "Check the output above or https://rpc.ubq.fi/ for deployment status."
