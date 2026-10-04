#!/usr/bin/env bash
# Non-destructive `anchor build` for local checks (make contract-build / contract-smoke).
#
# The Anchor CLI syncs program keys on build: it rewrites the chainpay
# `declare_id!` and `Anchor.toml [programs.devnet]` to the throwaway keypair in
# target/deploy, and reformats Anchor.toml (dropping the card_policy exclude
# comment). Those rewrites are needed while the build and the LiteSVM settlement
# test run (the test loads the .so at `chainpay::ID`, so both must agree), but they
# must never stay in the tree. Every file the CLI may touch is snapshotted first
# and restored on exit, including on failure or Ctrl-C.
#
# Usage: scripts/anchor-build-clean.sh [--smoke]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANCHOR="${ANCHOR:-anchor}"
cd "$ROOT"

GUARDED=(Anchor.toml programs/chainpay/src/lib.rs)
SNAPSHOT="$(mktemp -d "${TMPDIR:-/tmp}/chainpay-anchor-build.XXXXXX")"

for file in "${GUARDED[@]}"; do
  mkdir -p "$SNAPSHOT/$(dirname "$file")"
  cp -p "$file" "$SNAPSHOT/$file"
done

restore() {
  local status=$?
  for file in "${GUARDED[@]}"; do
    if ! cmp -s "$SNAPSHOT/$file" "$file"; then
      cp -p "$SNAPSHOT/$file" "$file"
    fi
  done
  rm -rf "$SNAPSHOT"
  exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$ANCHOR" build --ignore-keys --no-docs

if [[ "${1:-}" == "--smoke" ]]; then
  cargo test -p chainpay --features settlement-tests --test settlement -- --nocapture
fi
