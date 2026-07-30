#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

export CHAINPAY_RPC_URL="${CHAINPAY_RPC_URL:-https://api.devnet.solana.com}"
export CHAINPAY_PROGRAM_ID="${CHAINPAY_PROGRAM_ID:-3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4}"
export CHAINPAY_HTTP_HOST="${CHAINPAY_HTTP_HOST:-0.0.0.0}"
export CHAINPAY_HTTP_PORT="${CHAINPAY_HTTP_PORT:-${PORT:-3000}}"

cd "${REPO_ROOT}"

echo "Building ChainPay SDK and MCP server..."
npm --prefix mcp-server run build

echo "Starting ChainPay MCP HTTP server"
echo "Endpoint: http://${CHAINPAY_HTTP_HOST}:${CHAINPAY_HTTP_PORT}/mcp"
echo "Health:   http://${CHAINPAY_HTTP_HOST}:${CHAINPAY_HTTP_PORT}/healthz"

exec node "${SCRIPT_DIR}/dist/http.js"
