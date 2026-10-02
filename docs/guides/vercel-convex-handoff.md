# Vercel + Convex migration handoff

This change keeps the Anchor program, Rust transaction checks, wallet login,
SDK, MCP tools, and public HTTP contracts. Convex replaces off-chain PostgreSQL
storage. Vercel runs the existing Vite app, an Axum runtime adapter, and a Node
MCP handler. There is no new payment authority or new signing approval.

## Current deployment versus the existing service

The new projects are `chainpay-web`, `chainpay-relay`, and `chainpay-mcp` in
Dre's Vercel team. The separate Convex project is `andre-exilien/chainpay`;
`dev/migration` (`acrobatic-mole-703`) is an isolated **development** database.
The public Vercel deployment remains a **Solana Devnet** application.

- Website: https://chainpay-web-kappa.vercel.app
- Relay: https://chainpay-relay.vercel.app
- MCP: https://chainpay-mcp.vercel.app/mcp

Existing Render/Neon credentials belong to Kwasi and were not available for
this implementation. Therefore old records have **not** been imported, the
Render services have **not** been stopped, and the existing service has **not**
been cut over. Do not use this empty database to retry an unresolved operation
from the old service. Reconcile and migrate its original records first.

## Kwasi's checklist before replacing the existing service

- Confirm the existing deployment revision and that PostgreSQL migrations
  through `0008` match this branch. Share access through provider invitations
  or a secret manager; never put credentials in this PR.
- Provide a PostgreSQL snapshot/export or set `CHAINPAY_SOURCE_DATABASE_URL`
  locally for the read-only exporter below. Preserve every table, including
  operation claims, token hashes, signer IDs, and unresolved submissions.
- Configure a dedicated production Convex deployment and its own credentials
  before routing existing users to the replacement. Keep previews and rehearsal
  databases separate from that production data.
- Set the real RPC provider, Privy app/policy credentials and public agent
  identity, OpenRouter settings, merchant origin allowlists, and trusted seller
  mappings that are actually enabled on the existing service. No provider keys
  or signer wallets were recreated by this migration.
- Rehearse the import and rollback, agree a short maintenance window, then
  execute the cutover below. A separately approved Devnet settlement is still
  needed before claiming live payment acceptance on the new deployment.
- Update external MCP clients to the new MCP URL. Existing agent tokens can
  remain valid after their hashes are imported; wallet users sign in again on
  the new website origin.

## Runtime settings

Both services require `CHAINPAY_STORAGE=convex` on Vercel and
`CHAINPAY_CONVEX_SITE_URL=https://<deployment>.convex.site`.

| Setting | Where |
| --- | --- |
| `CHAINPAY_CONVEX_BACKEND_SECRET` | Convex and Axum only |
| `CHAINPAY_CONVEX_MCP_SECRET` | Convex and MCP only |
| `CHAINPAY_CONVEX_MIGRATION_SECRET` | Convex and operator environment only |
| `CHAINPAY_ALLOWED_ORIGINS` | Axum/MCP: exact browser origins, no wildcard |
| `CHAINPAY_RPC_URL` | Axum: Devnet provider; MCP: new relay `/rpc` |
| `CHAINPAY_BACKEND_URL` | MCP: new relay base URL |
| `CHAINPAY_APP_URL` | MCP: new frontend base URL for receipt links |
| `VITE_CHAINPAY_BACKEND_URL`, `VITE_CHAINPAY_RPC_URL` | Frontend build: relay and relay `/rpc` |
| `VITE_CHAINPAY_MCP_URL`, `VITE_CHAINPAY_AGENT_URL` | Frontend build: MCP `/mcp` and `/agent/chat` |

Use distinct random secrets of at least 32 characters. These are restricted
storage credentials, not Convex deployment keys or caller identities. Only
internal Convex functions access data; the authenticated storage gateway
allows each service only its own operations. Wallet/session checks still run
before private API operations. Never put a secret in a `VITE_*` value.

The local default remains PostgreSQL for compatibility; select it explicitly
with `CHAINPAY_STORAGE=postgres`. Memory storage is test-only. Vercel rejects
PostgreSQL/missing storage selection rather than silently using another store.

## Build and deploy

```sh
npm ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
npm --prefix sdk run build
npm run check
npm run check:convex
npm run test:convex
npm run test:migration
npm --prefix mcp-server test
npm --prefix frontend test
npm --prefix frontend run build
cargo test --workspace
cargo check -p chainpay-backend --features vercel
```

Select the intended Convex deployment explicitly and inspect its type before
running `npx convex dev --once` (development) or `npx convex deploy`
(production). `convex deploy` targets production even when the local selected
deployment is development. Configure the matching service secrets first.

Create upload roots from the repository, with a new release ID each time:

```sh
CHAINPAY_RELEASE_ID=release-001 node scripts/stage-vercel.mjs backend
CHAINPAY_RELEASE_ID=release-001 node scripts/stage-vercel.mjs mcp
CHAINPAY_RELEASE_ID=release-001 node scripts/stage-vercel.mjs frontend
```

Link each generated directory under `.vercel-staging/release-001/` to its
corresponding Vercel project, then deploy that directory with
`npx --yes vercel@60.1.3 deploy`. Promote only after checking health, wallet
login, public verification, authenticated MCP, and exact CORS behavior.
The staging script excludes credentials, build artifacts, and the parent
workspace. The Rust adapter uses Vercel's beta Rust runtime; keep its runtime
check as a release gate. Use Node 24 for the Node service and Vite build.

Vercel deployment protection must allow public access to the production website,
receipt routes, relay, and MCP endpoint. Preview protection can stay enabled,
but preview tests need its bypass mechanism and separate development credentials.
Never allow every `*.vercel.app` origin for wallet authentication.

Legacy MCP streams close cleanly after 240 seconds and clients must reconnect.
Modern POST MCP calls keep their existing behavior. Agent rate limits are
shared across instances through Convex. No automatic retry follows an uncertain
storage mutation; recover using the original operation ID.

## Preserve data and rehearse rollback

Snapshots contain private data. Keep them outside Git, encrypted at rest where
available, and transfer them privately. The exporter creates files with mode
0600 and emits only counts/hashes to stdout. Use a fresh file for each export.

1. On an isolated rehearsal database, apply the existing SQL migrations and
   populate representative records. For live cutover, pause and drain **both**
   old writer services before the final export. Maintenance banners alone do
   not stop direct MCP clients or an already running payment.
2. Export a consistent read-only PostgreSQL snapshot:

   ```sh
   node scripts/migrate-storage.mjs export-postgres .migration/source.ndjson
   node scripts/migrate-storage.mjs inspect .migration/source.ndjson
   ```

3. On the explicitly selected Convex target, enable
   `CHAINPAY_MAINTENANCE=true` and `CHAINPAY_CONVEX_MIGRATION_ENABLED=true`.
   Set its site URL and migration secret in the operator environment. Validate
   first, then import:

   ```sh
   node scripts/migrate-storage.mjs import-convex .migration/source.ndjson
   node scripts/migrate-storage.mjs import-convex .migration/source.ndjson --apply
   node scripts/migrate-storage.mjs export-convex .migration/roundtrip.ndjson
   node scripts/migrate-storage.mjs compare .migration/source.ndjson .migration/roundtrip.ndjson
   ```

   All ten tables must match by count and canonical row hash. Import preserves
   existing IDs and is resumable with the identical snapshot while writes remain
   paused. It rejects malformed/oversized rows instead of truncating them.
   The limit is 350KB per source row, 100 rows per batch, and 900KB per request.
   A snapshot that exceeds these limits needs a storage design change before
   cutover. Do not work around this by deleting fields.
4. Test reverse restore into an **empty**, migrated PostgreSQL database using
   `CHAINPAY_TARGET_DATABASE_URL` and
   `CHAINPAY_MIGRATION_TARGET_WRITE_PAUSED=true`:

   ```sh
   node scripts/migrate-storage.mjs restore-postgres .migration/roundtrip.ndjson
   node scripts/migrate-storage.mjs restore-postgres .migration/roundtrip.ndjson --apply
   ```

   Restore locks the target tables and commits in one transaction. It refuses
   nonempty tables. Re-export that database and compare against the Convex export.
   This also avoids resurrecting consumed/deleted challenges from a stale database.
5. Switch the new backend and MCP together, verify reads, disable migration
   mode, and reopen writes. Keep the old writers disabled. Observe failures,
   unknown payment outcomes, rate limits, latency, and platform usage.
6. Retire Render and its keep-alive job only after acceptance. Retain the original
   snapshot and rollback artifacts for seven days. Once Convex accepts new
   writes, rollback needs another write pause and a **fresh** Convex export
   restored into an empty PostgreSQL target; never reconnect a stale snapshot.

## Costs and evidence limits

### Verification performed on 2 October 2026

- A synthetic PostgreSQL fixture covering all ten tables was exported, imported
  into the separate Convex `dev/rehearsal` deployment, exported again, and restored
  into an empty PostgreSQL database. All ten row counts and canonical hashes
  matched in both directions, including u64 maximum values, microsecond
  timestamps, private signer identifiers, and operation claims.
- `node scripts/smoke-vercel.mjs` passed against the deployed Devnet stack:
  health, MCP discovery, exact-origin CORS, ephemeral wallet-message login,
  challenge replay rejection, authenticated connections/inbox reads, owner
  isolation, and session revocation. This script creates an unfunded identity
  and signs only a login message; it sends no transaction.
- Convex authorization/storage tests and migration preflight tests passed.
  MCP tests, frontend tests/build, and TypeScript checks passed.
- The MCP deployment pins `rpc-websockets` to 9.3.7 because 9.3.9's CommonJS
  entry requires ESM-only UUID on Vercel. Keep the cloud smoke test when updating
  this pin. Existing dependency audit findings remain outside this migration.

AI chat and delegated signing still need the original provider configuration.
The current stack is a review deployment, not acceptance of an existing-data
cutover or a new settlement.

Target $50/month hosting, excluding RPC and AI providers. Dre's Vercel team
already uses Pro; no plan upgrade is required for the initial setup. Use Convex
Starter and provider usage alerts, measure calls/bandwidth/compute, and do not
enable paid add-ons automatically. This is a budget target, not a guaranteed cap.

Automated fixtures, successful builds, health checks, wallet-message login,
and reading a historical receipt do not prove a new payment settled. No real
payment is authorized by this deployment or by merging this PR.
