# Configuration

**Choose the service you are running.** The [local setup guide](../getting-started/local-development.md)
provides complete commands; this page explains ownership of the settings.

## Shared service addresses

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CHAINPAY_RPC_URL` | SDK, MCP, backend, merchant | Solana Devnet RPC endpoint |
| `CHAINPAY_PROGRAM_ID` | SDK, MCP, backend, merchant | Deployed ChainPay program; must match the chosen network |
| `CHAINPAY_BACKEND_URL` | MCP and integrations | Axum relay and authentication endpoint |
| `CHAINPAY_STORAGE` | Axum and HTTP MCP | `convex` on Vercel; `postgres` for local/rollback compatibility |
| `CHAINPAY_CONVEX_SITE_URL` | Axum and HTTP MCP | Authenticated Convex HTTP storage origin |
| `DATABASE_URL` | PostgreSQL mode only | Axum applies migrations at startup |
| `CHAINPAY_ALLOWED_ORIGINS` | Axum and HTTP MCP | Explicit browser origins, including scheme and port |

Stdio tool discovery needs no database. The HTTP service uses the selected
durable store for connections and inbox data. Keep service secrets server-side.
See the [Vercel/Convex handoff](../guides/vercel-convex-handoff.md) for separate
backend/MCP credentials, deployment selection, and data-preserving cutover.

## Browser configuration

Vite loads `frontend/.env.local`; start from
[the example](../../frontend/.env.example). Restart Vite after editing it.

| Variable | Destination |
| --- | --- |
| `VITE_CHAINPAY_BACKEND_URL` | Axum base URL |
| `VITE_CHAINPAY_RPC_URL` | Solana RPC or the backend's `/rpc` endpoint |
| `VITE_CHAINPAY_MCP_URL` | MCP `/mcp` endpoint |
| `VITE_CHAINPAY_AGENT_URL` | MCP `/agent/chat` endpoint |

All `VITE_*` values are public. Wallet session tokens remain in memory; do not
put tokens, provider credentials, database passwords, or wallet keys in Vite settings.

## Caller authorization

Private HTTP calls carry an owner-session or scoped-connection bearer token.
For stdio private calls, set `CHAINPAY_CALLER_TOKEN` and the real backend URL.
See [connection setup](../guides/connect-an-agent.md#3-authorize-private-reads).

`CHAINPAY_HTTP_AUTH_TOKEN` and `CHAINPAY_BACKEND_AUTH_TOKEN` are service
configuration, not owner or agent identities. Blank settings do not make
private routes public. Server processes read their environment; copying the
[MCP example](../../mcp-server/.env.example) alone does not load it.

## Optional capabilities

- **Chat:** server-side `OPENROUTER_API_KEY` and provider/model settings in the
  [MCP guide](../../mcp-server/README.md). Tool discovery does not need an AI key.
- **Managed signing:** Privy configuration in the [backend guide](../../backend/README.md).
  Configuration alone is not evidence of an accepted delegated payment.
- **Merchant fetches:** exact origins in `CHAINPAY_X402_ALLOWED_ORIGINS`.
- **Standard x402 v2 settlement:** exact origins in `CHAINPAY_X402_RECEIPT_MERCHANTS`, a
  deliberate subset of the fetch allowlist. Being readable is not evidence that a merchant
  understands a ChainPay receipt PDA, so settlement needs its own list. Unset or empty means
  standard v2 is quoted and refused, never settled.
  `CHAINPAY_X402_ALLOW_HTTP=true` allows loopback HTTP for development only.
- **Seller statements:** public identity mappings in [trusted sellers](../guides/trusted-sellers.md).
  Statement signing stays on the merchant host.
- **Agent cards (Devnet + Lithic sandbox):** `CARDS_CONNECTOR_ENABLED=true` mounts the card
  routes; `scripts/check-release-env.mjs` lists the secrets it then requires.
  `CARDS_ISSUER_WRITES_ENABLED` and `CARDS_CHECKOUT_ENABLED` are off unless `true`.
  `CARDS_ISSUER_WRITES_ENABLED=false` blocks **every** issuer write, including the
  pause a freeze needs, so it is not a safe way to stop new cards.
- **`CARDS_NEW_ACTIVATION_ENABLED`** (default on): the selective gate for new card risk.
  Set it to exactly `false` to refuse `POST /v1/cards/prepare`, `GET /v1/cards/{id}/setup` (the same
  unsigned setup transactions, for finishing a stopped setup) and `POST /v1/cards/{id}/activate`
  (`503 new_activation_disabled`, not retryable). Card reads, issuer webhooks and ASA decisions,
  the reconcile cron, freeze (issuer pause), unfreeze of an already activated card, statements,
  repayments and recovery keep working. While it is off, reconcile still finishes the public
  commitment of an activation accepted earlier but never opens a card that was not already open.
  Unset or `true` keeps today's behaviour. Any other value turns new activations off and is
  logged; the release check refuses it.
- **Card activation order:** limits mirrored at the issuer while the card is paused → checkpoint
  scheduled on PER → `CardCommitment` read back from the base layer (finalized) with the expected
  seq, policy version and period → policy version re-checked → issuer opened. A scheduled
  checkpoint is not a public commitment. The reconcile cron (`.github/workflows/cards-reconcile.yml`)
  re-drives the same persisted activation or checkpoint until the readback matches.
- **Owner webhooks:** off unless `OWNER_WEBHOOKS_ENABLED=true`. See
  [owner webhooks](#owner-webhooks).

## Owner webhooks

Relay (backend) settings. With `OWNER_WEBHOOKS_ENABLED` unset or `false`, every
webhook route answers 404 and no event is written. With `true`, all of these are
required and the relay refuses to start without them:

| Variable | Value |
| --- | --- |
| `OWNER_WEBHOOKS_ENABLED` | `true` or `false`. |
| `OWNER_WEBHOOKS_SECRET_KID` | Id of the key that seals new endpoint secrets (letters, digits, `_`, `-`; up to 32). |
| `OWNER_WEBHOOKS_SECRET_KEY_<KID>` | 32 random bytes, base64 (`openssl rand -base64 32`). Keep old ids set after changing `OWNER_WEBHOOKS_SECRET_KID` so existing endpoints can still sign. Separate from the card record keys. |
| `CRON_SECRET` | 16+ characters. Bearer token for `POST /internal/cron/webhooks/dispatch` (shared with the card reconcile route). |
| `CHAINPAY_APP_URL` | Public web origin, e.g. `https://chainpay.example`. Events link to `<origin>/verify/<receipt>`. |

Storage: run PostgreSQL migration `0013_owner_webhooks.sql` (applied on relay
start), or deploy the Convex schema and functions **before** the relay, since
`put_payment` gains an optional outbox argument.

Scheduler: the `Owner webhooks dispatch` GitHub workflow calls the dispatch
route every 5 minutes once the repository variable `OWNER_WEBHOOKS_DISPATCH_URL`
(relay origin) and secret `OWNER_WEBHOOKS_CRON_SECRET` (the relay's
`CRON_SECRET`) are set; `VERCEL_AUTOMATION_BYPASS_SECRET` only if the deployment
is protected. Delivery cadence follows that schedule. See the
[owner webhooks guide](../guides/owner-webhooks.md).

The current deployment workflow is the [Vercel/Convex handoff](../guides/vercel-convex-handoff.md).
[render.yaml](../../render.yaml) remains as a legacy rollback reference; the existing
Render services have not been retired by this code change.
