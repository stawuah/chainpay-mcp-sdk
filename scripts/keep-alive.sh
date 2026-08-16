#!/usr/bin/env bash

# Warm the public ChainPay services. Override any URL for a different
# deployment, for example:
# CHAINPAY_FRONTEND_URL=https://demo.example.com ./scripts/keep-alive.sh

set -u

FRONTEND_URL=${CHAINPAY_FRONTEND_URL:-https://chainpay-frontend.onrender.com}
BACKEND_URL=${CHAINPAY_BACKEND_URL:-https://chainpay-backend.onrender.com/healthz}
MCP_URL=${CHAINPAY_MCP_URL:-https://chainpay-mcp.onrender.com/healthz}
TIMEOUT_SECONDS=${CHAINPAY_KEEPALIVE_TIMEOUT_SECONDS:-20}

timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
failed=0

ping_service() {
  local name=$1
  local url=$2

  if curl --fail --silent --show-error --max-time "$TIMEOUT_SECONDS" --output /dev/null "$url"; then
    printf '[%s] %-9s OK       %s\n' "$timestamp" "$name" "$url"
  else
    printf '[%s] %-9s FAILED   %s\n' "$timestamp" "$name" "$url" >&2
    failed=1
  fi
}

ping_service "frontend" "$FRONTEND_URL"
ping_service "backend" "$BACKEND_URL"
ping_service "mcp" "$MCP_URL"

exit "$failed"
