# Vercel + Convex migration handoff

This change keeps the Anchor program, Rust transaction checks, wallet login,
SDK, MCP tools, and public HTTP contracts. Convex replaces off-chain PostgreSQL
storage. Vercel runs the existing Vite app, an Axum runtime adapter, and a Node
MCP handler. There is no new payment authority or new signing approval.

## Inputs Kwasi needs to provide

PR #24 is merged into `master` at `8c6b433`, but the existing service has not
been cut over. Kwasi and Dre can use this list to track the inputs needed before
replacing Render/Neon. Mark an item complete only after its recipient has
confirmed access or received the information through a private channel.

| Input from Kwasi | What Dre needs it for |
| --- | --- |
| Confirm Vercel's GitHub app can read `stawuah/chainpay-mcp-sdk` and Dre has the intended repository access. | Link the three Vercel projects to upstream `master`. |
| Identify the currently deployed Render/Neon revision and provide the SQLx migration history. | Compare the source schema with the canonical migrations before export. |
| Provide a complete PostgreSQL snapshot/export or grant a read-only source connection for the exporter. Include payment operations, unresolved submissions, token hashes, signer IDs, and claims. | Rehearse and verify the 13-table import without losing recovery state. |
| Provide an inventory of the settings enabled on the existing service: Devnet RPC provider, Privy app and policy, public agent identity, OpenRouter, merchant origin allowlists, and trusted-seller mappings. | Configure equivalent services without guessing or enabling unused providers. |
| Agree on a maintenance window and name who will pause both old writers, reconcile unresolved operations, verify the import, switch traffic, and perform rollback if needed. | Complete the cutover without creating duplicate payment attempts. |

Share source data, credentials, and private settings through provider invitations
or a secret manager. Do not paste them into this repository, a PR, or a chat.
Never share wallet keys or seed phrases. Dre owns the Vercel/Convex setup; the
steps and environment variables are detailed below. Crossmint activation and a
Devnet program upgrade remain separate decisions.

## Start here: repository owner and hosting owner

**Kwasi owns the repository and merge; Dre owns Vercel and Convex.** The
combined release in PR #24 was merged with a merge commit, preserving the
feature histories from #19–27 and their review corrections. Do not deploy
intermediate feature heads: they do not contain the combined Convex
implementations.

- **Kwasi:** confirm repository access for the Vercel GitHub app and Dre's
  GitHub identity, configure the `Release checks` required jobs, and supply the
  source schema/export and enabled provider settings privately. Program upgrade
  authority stays with Kwasi.
- **Dre:** configure the three existing Vercel projects below and their matching
  Convex environment. Enter secrets through provider settings, not PR comments.
  Select deployment types in the Convex dashboard; labels alone do not prove
  that a URL is a preview or production database.
- **Both:** record the release commit, each Vercel deployment ID, Convex deployment
  name/type, three service origins, and who performs cutover/rollback. Keep
  automatic production domain assignment paused until data acceptance passes.

### Deployment ownership and ordering

Production uses `.github/workflows/deploy-vercel.yml` after successful Release
checks on the exact current `master` revision. Manual workflow dispatch has the
same gate. Convex schema/functions deploy first, relay and MCP next, frontend
last. Disable competing Vercel native Git production deployments so a push cannot
bypass that order. Keep schema/functions compatible with the services still
running during the rollout.

The workflow stages minimal upload roots with `scripts/stage-vercel.mjs` and
uses Vercel CLI 54.14.0. A successful production deployment is not migration
acceptance. Before cutover, existing Render traffic remains authoritative.

Native project roots (`frontend`, `deploy/relay`, `mcp-server`) may be used for
explicitly configured previews with source outside the root included. Every
preview requires an isolated development/preview database, matching relay and
MCP, and exact-origin CORS. Never use production credentials in previews.

PR #34 adds the coordinated cutover script and a checked production manifest.
Merge #31, #33, #30 and #35 first; reserve #34 for the maintenance window. Kwasi
owns every merge; Dre operates the provider settings and data verification.
Until #34 lands, follow the migration safeguards below and do not claim the
new cutover gates are active. Once present, its `docs/guides/cutover-runbook.md`
is the step-by-step execution guide.

All projects require `CHAINPAY_RELEASE_ENVIRONMENT`,
`CHAINPAY_CONVEX_DEPLOYMENT_TYPE` and `CHAINPAY_RELEASE_GROUP`. Production must
match the reviewed target/origins in #34's manifest; previews use independent
settings. Provider ownership, source-writer suspension, and current data must
still be verified by the operators. Keep shared pet mode off during cutover:
community data is Convex-only and outside the financial 13-table rollback.

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

PR #33 records a 3 October rehearsal of 47 source rows and preparation of the
`notable-bee-447` production deployment. Treat those as dated operator reports,
not current-state guarantees. This review uses isolated fixtures and does not
read current private source data, suspend Render, or execute the cutover. Confirm
access, current source history, provider settings, and the maintenance window
privately before proceeding. Do not retry an old unresolved operation against
an empty replacement database; migrate its original records first.

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
`npx --yes vercel@54.14.0 deploy`. Promote only after checking health, wallet
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

   Owner webhook endpoints (migration 0013) are not migrated: their secrets are
   sealed by the source relay's keys. Export refuses while any exist, so disable
   them first and have owners re-register on the target.

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
The historical stack evidence does not establish acceptance of an existing-data
cutover or a new settlement. Verify the current provider state during the window.

For current combined-release results and limits, see the [release review](../project/release-review-2026-10-02.md).

Target $50/month hosting, excluding RPC and AI providers. Dre's Vercel team
already uses Pro; no plan upgrade is required for the initial setup. Use Convex
Starter and provider usage alerts, measure calls/bandwidth/compute, and do not
enable paid add-ons automatically. This is a budget target, not a guaranteed cap.

Automated fixtures, successful builds, health checks, wallet-message login,
and reading a historical receipt do not prove a new payment settled. No real
payment is authorized by this deployment or by merging this PR.
