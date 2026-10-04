#!/usr/bin/env bash
# Latest raw version of each image → frontend/public/use-cases/<slug>-{800,1600}.webp
# Usage: finish.sh [id ...]   — no args = every image
set -euo pipefail
cd "$(dirname "$0")/../raw"
OUT=../../../frontend/public/use-cases; mkdir -p "$OUT"
ONLY=" $* "
while read -r id slug; do
  [ "$ONLY" = "  " ] || [[ "$ONLY" == *" $id "* ]] || continue
  src=$(ls "$id"-v*.png | sort -V | tail -1)
  for w in 1600 800; do
    magick "$src" -resize "${w}x$((w*3/4))^" -gravity center -extent "${w}x$((w*3/4))" -quality 80 "$OUT/$slug-$w.webp"
  done
done <<'MAP'
sponsor-funds-agent sponsor-funds-your-agent
pay-per-api-call pay-per-api-call
research-agent-buys-data research-agent-buys-data
buy-tools-from-catalog buy-tools-from-a-catalog
pay-from-your-ai-app pay-from-your-ai-app
team-agent-allowance team-agent-allowance
receipts-for-accounting receipts-for-accounting
invoices-matched-to-payments invoices-matched-to-payments
approve-big-buys approve-big-buys-yourself
one-tap-stop one-tap-stop
private-agent-card private-agent-card
spend-overview-anywhere spend-overview-anywhere
get-paid-by-agents get-paid-by-agents
purchase-order-link send-a-purchase-order-link
prove-you-delivered prove-you-delivered
agent-shopping-checkout agent-shopping
MAP
