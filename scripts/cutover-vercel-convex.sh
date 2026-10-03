#!/usr/bin/env bash
# Move ChainPay's off-chain data from Render/Neon to production Convex and
# point the Vercel services at it. Run the steps in order during the agreed
# window; each one stops on the first error. See docs/guides/cutover-runbook.md.
#
#   preflight  Render writers are paused; prod Convex is empty and in maintenance
#   migrate    final Neon export -> prod Convex import -> round-trip compare
#   switch     point Vercel production at prod Convex (takes effect on next deploy)
#   open       leave maintenance so the new stack accepts writes
#   smoke      wallet-login smoke test against the Vercel origins (no transaction)
#   abort      put prod Convex back in maintenance before Render resumes
#
# Inputs (never commit them):
#   CHAINPAY_SOURCE_DATABASE_URL  Neon primary, read only during migrate
#   CONVEX_PROD_ENV_FILE          CONVEX_DEPLOY_KEY (production), CHAINPAY_CONVEX_SITE_URL
#                                 and the three service secrets
#                                 (default ~/.config/chainpay/convex-prod.env)
#   Vercel CLI logged in with access to the "chainpay" team.
set -euo pipefail
cd "$(dirname "$0")/.."

step="${1:-}"
OUT="${CHAINPAY_CUTOVER_DIR:-.migration/cutover-$(date -u +%Y%m%d)}"
ENV_FILE="${CONVEX_PROD_ENV_FILE:-$HOME/.config/chainpay/convex-prod.env}"
SCOPE="${VERCEL_SCOPE:-chainpay}"
WEB_ORIGIN="${CHAINPAY_WEB_ORIGIN:-https://www.chainpayai.app}"
# Every origin the website is served from; the relay and MCP reject the rest.
WEB_ORIGINS="${CHAINPAY_WEB_ORIGINS:-$WEB_ORIGIN,https://chainpayai.app,https://chainpay-web-kappa.vercel.app}"
RELEASE_GROUP="${CHAINPAY_RELEASE_GROUP:-release-$(date -u +%Y%m%d)}"
RENDER_HEALTH=(https://chainpay-backend.onrender.com/healthz https://chainpay-mcp.onrender.com/healthz)

die() { echo "STOP: $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is not set"; }
convex() { need CONVEX_DEPLOY_KEY; npx convex "$@"; }
migrate() { node scripts/migrate-storage.mjs "$@"; }
counts() { migrate inspect "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);const r=t.tables??t;console.log(Object.entries(r).map(([k,v])=>`${k}=${v.count}`).join(" "))})'; }

load_prod() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  need CONVEX_DEPLOY_KEY; need CHAINPAY_CONVEX_SITE_URL; need CHAINPAY_CONVEX_BACKEND_SECRET
  need CHAINPAY_CONVEX_MCP_SECRET; need CHAINPAY_CONVEX_MIGRATION_SECRET
}

# Write one production variable through stdin so values never reach argv.
vercel_set() {
  local project="$1" key="$2" value="$3" dir
  dir="$(mktemp -d)"
  vercel link --yes --project "$project" --scope "$SCOPE" --cwd "$dir" >/dev/null 2>&1
  printf '%s' "$value" | vercel env add "$key" production --force --yes --cwd "$dir" >/dev/null 2>&1 \
    || die "could not set $key on $project"
  rm -rf "$dir"
  echo "  $project $key set"
}

case "$step" in
  preflight)
    load_prod
    mkdir -p "$OUT"; chmod 700 "$OUT"
    for url in "${RENDER_HEALTH[@]}"; do
      code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$url" || true)
      [ "$code" != 200 ] || die "$url still answers 200; suspend both Render writers first"
    done
    read -r -p "Kwasi confirmed chainpay-backend, chainpay-mcp and keep-alive are suspended on Render? Type PAUSED: " ok
    [ "$ok" = PAUSED ] || die "not confirmed"
    [ "$(convex env get CHAINPAY_MAINTENANCE)" = true ] || die "prod Convex is not in maintenance"
    convex env set CHAINPAY_CONVEX_MIGRATION_ENABLED true >/dev/null
    migrate export-convex "$OUT/prod-before.ndjson" >/dev/null
    before=$(counts "$OUT/prod-before.ndjson")
    echo "$before" | grep -qE '=[1-9]' && die "prod Convex is not empty: $before"
    echo "OK: Render paused, prod Convex empty and in maintenance, migration enabled."
    ;;
  migrate)
    load_prod; need CHAINPAY_SOURCE_DATABASE_URL
    [ -s "$OUT/prod-before.ndjson" ] || die "run preflight first"
    migrate export-postgres "$OUT/source.ndjson" >/dev/null
    echo "Neon:   $(counts "$OUT/source.ndjson")"
    migrate import-convex "$OUT/source.ndjson" >/dev/null
    migrate import-convex "$OUT/source.ndjson" --apply >/dev/null
    migrate export-convex "$OUT/roundtrip.ndjson" >/dev/null
    migrate compare "$OUT/source.ndjson" "$OUT/roundtrip.ndjson" >/dev/null \
      || die "Convex does not match Neon. Run abort, then resume Render."
    echo "Convex: $(counts "$OUT/roundtrip.ndjson")"
    convex env remove CHAINPAY_CONVEX_MIGRATION_ENABLED >/dev/null
    echo "OK: all 13 tables match by count and hash. Migration mode is off again."
    ;;
  switch)
    load_prod
    [ -s "$OUT/roundtrip.ndjson" ] || die "run migrate first"
    for project in chainpay-relay chainpay-mcp chainpay-web; do
      vercel_set "$project" CHAINPAY_RELEASE_ENVIRONMENT production
      vercel_set "$project" CHAINPAY_CONVEX_DEPLOYMENT_TYPE prod
      vercel_set "$project" CHAINPAY_RELEASE_GROUP "$RELEASE_GROUP"
    done
    for project in chainpay-relay chainpay-mcp; do
      vercel_set "$project" CHAINPAY_CONVEX_SITE_URL "$CHAINPAY_CONVEX_SITE_URL"
      vercel_set "$project" CHAINPAY_ALLOWED_ORIGINS "$WEB_ORIGINS"
    done
    vercel_set chainpay-relay CHAINPAY_CONVEX_BACKEND_SECRET "$CHAINPAY_CONVEX_BACKEND_SECRET"
    vercel_set chainpay-mcp CHAINPAY_CONVEX_MCP_SECRET "$CHAINPAY_CONVEX_MCP_SECRET"
    vercel_set chainpay-mcp CHAINPAY_APP_URL "$WEB_ORIGIN"
    echo "OK: Vercel production now targets prod Convex. Merge the cutover PR (or run"
    echo "    'gh workflow run deploy-vercel.yml --ref master') and wait for the deploy."
    ;;
  open)
    load_prod
    convex env set CHAINPAY_MAINTENANCE false >/dev/null
    echo "OK: prod Convex accepts writes. From here, rollback needs a fresh Convex export."
    ;;
  smoke)
    CHAINPAY_APP_URL="$WEB_ORIGIN" node scripts/smoke-vercel.mjs
    ;;
  abort)
    load_prod
    convex env set CHAINPAY_MAINTENANCE true >/dev/null
    convex env remove CHAINPAY_CONVEX_MIGRATION_ENABLED >/dev/null || true
    echo "OK: prod Convex is read-only again. Resume the Render services; nothing on Neon changed."
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
