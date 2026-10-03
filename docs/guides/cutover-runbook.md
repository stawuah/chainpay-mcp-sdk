# Cutover runbook: Render + Neon → Vercel + Convex

Kwasi owns merges and Render. Dre operates Vercel/Convex. This procedure moves
operational records; it never signs a payment or upgrades the Solana program.
The [handoff](vercel-convex-handoff.md) documents schema and recovery semantics.

## Release prerequisites

1. Merge #31, #33, #30 and #35 after their checks pass. Keep shared-pet mode off
   through cutover. Its Convex-only community history is outside the 13-table
   PostgreSQL snapshot and must not acquire production writes during this window.
2. Reserve a maintenance window with both operators present. Keep #34 a draft
   until ready for the coordinated switch. Kwasi merges #34 only at step 5 below.
3. Use Node 24, `npm ci --ignore-scripts`, authenticated `gh`, and Vercel CLI
   54.14.0 with access to the `chainpay` team. Production deployments must use
   the checked GitHub Actions workflow; disable competing native Git production
   deployments. Previews remain separate.
4. Put `CONVEX_DEPLOY_KEY`, `CHAINPAY_CONVEX_SITE_URL`, and the three distinct
   service secrets in `~/.config/chainpay/convex-prod.env` (mode 0600). The key
   must be a `prod:notable-bee-447|…` key. Never share the values in logs or PRs.
5. Export `CHAINPAY_SOURCE_DATABASE_URL` privately and set a unique
   `CHAINPAY_CUTOVER_DIR=.migration/cutover-<window-id>`. Reuse that directory for
   retries in the same window. Do not modify the script during an active attempt.
6. Verify current provider settings and required secrets privately. Prior reports
   describe a 47-row rehearsal on 3 October; that is historical evidence, not a
   fresh source export or proof that today's production target is still empty.

The reviewed production target and service origins live in
`scripts/production-release.json`. Production build guards pin those values;
changing an environment label alone cannot bless a development database.
Convex deployment keys are also checked against that production target.
Provider ownership and source-writer suspension still require operator checks.

## Coordinated window

| Step | Owner | Action |
| --- | --- | --- |
| 1 | Kwasi | Suspend both Render writer services and keep-alive. Drain in-flight requests and record/reconcile uncertain operations without issuing replacement payments. Confirm this to Dre. |
| 2 | Dre | Run `scripts/cutover-vercel-convex.sh preflight`. Confirm `PAUSED` only after step 1. It checks maintenance, matching secrets, absence of any writes-opened marker, and an empty validated target snapshot. |
| 3 | Dre | Run `scripts/cutover-vercel-convex.sh migrate`. It freezes one source snapshot, imports it resumably, and requires all 13 table counts/hashes to match. |
| 4 | Dre | Run `scripts/cutover-vercel-convex.sh switch`. It writes the reviewed production settings to all three Vercel projects, preserving preview settings. A partial failure can repeat this step. |
| 5 | Kwasi | Merge #34. Wait for Release checks and the complete Convex → relay/MCP → frontend deployment to succeed. Do not manually bypass a failed check. |
| 6 | Dre | Set `CHAINPAY_RELEASE_SHA` to the full merged master revision and run `scripts/cutover-vercel-convex.sh verify`. This checks the successful deployment workflow and current production aliases for that exact revision. |
| 7 | Dre | Run `scripts/cutover-vercel-convex.sh open`. It rechecks snapshots and deployments, records a durable remote writes-opened marker **before** reopening writes, then saves the local checkpoint. |
| 8 | Dre | Run `scripts/cutover-vercel-convex.sh smoke`. Login and isolation checks create/revoke an ephemeral session; no transaction is sent. Any failure now requires the post-open recovery path. |
| 9 | Kwasi | Redirect the Render website to `https://www.chainpayai.app` and update external MCP clients to `https://chainpay-mcp.vercel.app/mcp`. |

Each step stops on failure. A file merely existing is never migration acceptance.
Inspect checkpoints and private provider status before retrying. An interrupted
export stays `.partial`; import retries reuse the original validated source.
Do not re-export a changing source into an already partially imported target.
The `.lock` directory prevents concurrent steps; after a hard process kill,
confirm that no step is running before removing that lock manually.

## Abort and rollback

Run `scripts/cutover-vercel-convex.sh abort` to pause Convex and disable migration
mode. It remains available when the local checkpoint is corrupt or the script
changed. Resolve any concurrent step before aborting.

**Before opening:** after the script confirms safe pre-open abort, cancel or wait
for pending deployments, keep Vercel traffic closed, then Kwasi may resume Render
on unchanged Neon. A partially imported Convex target is not empty: inspect and
reset it through a separately reviewed operator procedure before starting a new
attempt in a new directory. The script never deletes imported records automatically.

**After opening, or an uncertain opening:** keep Render suspended. Pause writers,
export fresh Convex records, restore them into an empty PostgreSQL database with
all canonical migrations, re-export and compare all 13 tables, then change Render
to that verified database. Never resume the stale Neon database. The remote
`CHAINPAY_CUTOVER_WRITES_OPENED` marker intentionally survives abort and lost local
files; do not clear it to bypass recovery. A lost response while opening can be
reconciled by retrying `open` with the same checkpoint and matching deployment.

## Acceptance and retention

Record the source manifest, release revision, deployment IDs, verification results,
and owners. Observe auth failures, unknown settlements, latency and storage errors.
Keep shared pet writes disabled until this financial-data cutover is accepted;
a later rollback after pet activation also needs a separate native Convex backup
and restoration plan for the community tables.

Retain suspended Render services and protected snapshots for at least seven days
and until acceptance/rollback needs are resolved; deletion is a later explicit
operator task. Rotate credentials previously shared outside the secret manager.
A passing rehearsal or login smoke test is not evidence of a new settled payment.
