#!/usr/bin/env bash
# Explicit operator commands only; see docs/guides/cutover-runbook.md.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${CONVEX_PROD_ENV_FILE:-$HOME/.config/chainpay/convex-prod.env}"
if [[ ! -f "$ENV_FILE" ]]; then echo "STOP: missing production environment file" >&2; exit 1; fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec node scripts/cutover-vercel-convex.mjs "$@"
