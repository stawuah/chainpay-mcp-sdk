# Vercel + Convex migration handoff

This change keeps the Anchor program, Rust transaction checks, wallet login,
SDK, MCP tools, and public HTTP contracts. Convex replaces off-chain PostgreSQL
storage. Vercel runs the existing Vite app, an Axum runtime adapter, and a Node
MCP handler. There is no new payment authority or new signing approval.

## Start here: repository owner and hosting owner

**Kwasi owns the repository and merge; Dre owns Vercel and Convex.** Review the
combined release in PR #24 before merging any of the overlapping runtime PRs.
Its integration history includes #19–27 and the review corrections. Prefer a
**merge commit**, which preserves the individual feature histories. If choosing
squash, close the superseded feature PRs explicitly. Do not deploy intermediate
feature heads: they do not contain the combined Convex implementations.

- **Kwasi:** approve repository access for the Vercel GitHub app and Dre's GitHub
  identity, review the combined diff, enable the `Release checks` required jobs,
  and merge only when they pass. Supply the source schema/export and enabled
  provider settings privately. Program upgrade authority stays with Kwasi.
- **Dre:** configure the three existing Vercel projects below and their matching
  Convex environment. Enter secrets through provider settings, not PR comments.
  Select deployment types in the Convex dashboard; labels alone do not prove
  that a URL is a preview or production database.
- **Both:** record the release commit, each Vercel deployment ID, Convex deployment
  name/type, three service origins, and who performs cutover/rollback. Keep
  automatic production domain assignment paused until data acceptance passes.

### Git-linked Vercel settings

Connect **all three** projects to `stawuah/chainpay-mcp-sdk`, production branch
`master`, in Dre's Vercel team. Enable **Include source files outside of the Root
Directory** for every project. Node must be **24.x**. Clear old dashboard build
command overrides so the checked-in `vercel.json` files are authoritative.

| Vercel project | Root Directory | Framework/config |
| --- | --- | --- |
| `chainpay-web` | `frontend` | Vite; `frontend/vercel.json` |
| `chainpay-relay` | `deploy/relay` | Other; isolated Cargo package and Rust adapter |
| `chainpay-mcp` | `mcp-server` | Other; Node handler at `api/mcp.js` |

These roots include shared SDK/backend source from outside their directories;
without the include-source setting native Git builds cannot work. The Rust
wrapper builds the relay only, never deploys the Anchor program. The old
`stage-vercel.mjs` workflow remains available for an explicit CLI release.

Git-linked pushes build previews automatically once repository access and
branch-specific settings exist. For each tested preview branch, provision one
isolated Convex dev/preview deployment, deploy its schema **before** starting
the three service builds, and configure matching branch-specific Vercel variables.
Use stable branch preview aliases for frontend/relay/MCP so later commits do not
change their cross-service URLs. Authorize only that exact frontend origin in
CORS. A preview without its own configured services/database must fail build,
not use production or the historic review stack. Fork PR builds may require an
authorized Vercel member's approval; never expose deployment keys to untrusted PR
workflows. CI in this repository uses no cloud secrets.

Set these nonsecret build guards in **each** project/environment:

- `CHAINPAY_RELEASE_ENVIRONMENT=preview` or `production`, matching `VERCEL_ENV`.
- `CHAINPAY_CONVEX_DEPLOYMENT_TYPE=dev`/`preview` for previews, `prod` for production.
- `CHAINPAY_RELEASE_GROUP`: one shared identifier for the selected database and
  three origins, such as `pr-24-review` or `release-20261002`.

The guard checks required variables and paired RPC/agent URLs. It cannot verify
provider account ownership or infer a deployment's type from its hostname.
Before promotion, compare actual deployment settings across all projects and
run the smoke test with those exact origins. Do not point previews at production
credentials, provider signers, or source operational data.

Deploy Convex schema once per release, then relay/MCP, then frontend. Keep schema
changes backward compatible during rolling service deployment. Production native
builds require production environment variables; redeploy against that environment
rather than promoting a build containing preview URLs. Until first cutover is
accepted, builds may complete but must not replace the existing live domains.

### Combined database layout

Canonical migration order is `0009_connector_jobs`, `0010_receipt_requests`,
`0011_observed_policies`, `0012_mandate_requests`. There are **13** exported
persistent tables, including the three new feature tables. Crossmint uses columns
on `x402_payments`, not a separate jobs table. Rate-limit buckets are ephemeral.

The exporter verifies SQLx migration checksums. It accepts canonical histories
from `0008` onward; older sources export new feature tables as empty and normalize
missing connector fields to `x402`/null. It refuses the competing branch-specific
`0009_receipt_requests` history or tables/columns that disagree with the ledger.
For such a source, stop and reconcile on an isolated copy; never edit the live
SQLx history to suppress an error. Restore requires the current complete schema.

If upgrading an existing **Convex** database in place, pause writers and run
`maintenance:backfillConnectorIndexes` with `{ "cursor": null }`, repeating with
the returned cursor until `done` is true. Fresh snapshot imports already create
these indexes. Legacy history fails explicitly until the backfill completes.

### Crossmint and receipt-program release gates

Crossmint software is included but **disabled by default** on the server and UI.
Set staging provider credentials privately; keep both `CHAINPAY_CROSSMINT_ENABLED`
and `VITE_CHAINPAY_CROSSMINT` off until a separately approved staging transaction
proves that Crossmint recognizes the mandate's inner transfer, the correct payer,
and the intended order. A successful Solana receipt alone is insufficient.
No direct transfer or agent-funded-wallet fallback is authorized by this release.
Order delivery is separate from payment finality; unknown outcomes retain their
original operation IDs. See [MCP Crossmint setup](../../mcp-server/README.md#crossmint-staging-connector) for supported terms.

Deploy the dual-size receipt readers from #25 before upgrading #23's program.
Both 282-byte and 371-byte receipts must remain readable. Kwasi uses the pinned
Anchor toolchain for any separately authorized Devnet upgrade and checks the
program ID. Hosting setup never upgrades the program automatically.

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

- Confirm the existing deployment revision and SQLx migration history against
  the canonical layout above. Share access through provider invitations
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
| `CHAINPAY_CROSSMINT_ENABLED=false` | Axum and MCP until provider acceptance |
| `CROSSMINT_API_KEY` | Axum and MCP only; staging Orders read/update access |
| `CHAINPAY_CROSSMINT_AUTH_SECRET` | Matching Axum/MCP secret, at least 32 characters; never browser-visible |
| `VITE_CHAINPAY_CROSSMINT=false` | Frontend until provider acceptance |
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
npm run test:migration:integration
node --test scripts/check-release-env.test.mjs
npm --prefix mcp-server test
npm --prefix frontend test
npm --prefix frontend run build
cargo test --workspace
cargo check -p chainpay-backend --features vercel
cargo check --manifest-path deploy/relay/Cargo.toml --locked
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

   All 13 tables must match by count and canonical row hash. Import preserves
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

### Historical baseline verification (before combined-release review)

- A synthetic PostgreSQL fixture covering the original ten tables was exported, imported
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

For current combined-release results and limits, see the [release review](../project/release-review-2026-10-02.md).

Target $50/month hosting, excluding RPC and AI providers. Dre's Vercel team
already uses Pro; no plan upgrade is required for the initial setup. Use Convex
Starter and provider usage alerts, measure calls/bandwidth/compute, and do not
enable paid add-ons automatically. This is a budget target, not a guaranteed cap.

Automated fixtures, successful builds, health checks, wallet-message login,
and reading a historical receipt do not prove a new payment settled. No real
payment is authorized by this deployment or by merging this PR.
