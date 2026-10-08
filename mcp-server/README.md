# ChainPay MCP server

Discover payment tools, inspect mandates, prepare transactions, and read receipts
through stdio or HTTP. **Start with [Connect an agent](../docs/guides/connect-an-agent.md)**
for a read-only first result, client configuration, and scoped authorization.

## Run locally

From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm --prefix mcp-server run build
node mcp-server/dist/server.js
```

The build also builds the local SDK. For HTTP, run
`node mcp-server/dist/http.js` with the environment below. From this component
directory, `./start-http.sh` builds and starts HTTP automatically.

## Host the HTTP service

Deploy the repository root: this package consumes the local SDK workspace.
The root [Dockerfile](../Dockerfile) and [Render blueprint](../render.yaml)
provide deployment entry points.

```text
Build: npm ci --include=dev --ignore-scripts && npm --prefix mcp-server run build
Start: node mcp-server/dist/http.js
Health check: /healthz
```

| Setting | Purpose |
| --- | --- |
| `CHAINPAY_RPC_URL` | Solana RPC; use the intended Devnet endpoint |
| `CHAINPAY_PROGRAM_ID` | Program to read and build against |
| `CHAINPAY_BACKEND_URL` | Axum relay and authentication service |
| `DATABASE_URL` | PostgreSQL for connections, inbox, and activity; required in production |
| `CHAINPAY_ALLOWED_ORIGINS` | Explicit allowed browser origins |
| `CHAINPAY_HTTP_PORT` | Local HTTP port override |
| `CHAINPAY_AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY` | Optional inbox assistant provider |
| `CHAINPAY_X402_ALLOWED_ORIGINS` | Exact trusted HTTPS merchant origins ChainPay may fetch, comma-separated |
| `CHAINPAY_X402_RECEIPT_MERCHANTS` | Subset of those origins that verify a ChainPay receipt PDA and deliver against it. Only these can settle a standard x402 v2 challenge. Unset means no v2 settlement |

Use HTTPS when hosted. Production startup refuses an in-memory fallback if the
database is missing. Tokens are hashed at rest. The assistant invokes the same
caller permission checks as external clients.

Private HTTP calls use the caller's owner-session or scoped-connection bearer
token, which MCP forwards to Axum. Shared service tokens do not authorize an
owner. Stdio private calls use `CHAINPAY_BACKEND_URL` plus
`CHAINPAY_CALLER_TOKEN`. See the [authentication steps](../docs/guides/connect-an-agent.md#3-authorize-private-reads)
and [configuration reference](../docs/reference/configuration.md) in the repository docs.

## Routes

| Route | Access and purpose |
| --- | --- |
| `GET /`, `/docs` | Public documentation preview |
| `GET /healthz` | Public service health |
| `GET /tools` | Public schemas from the tool registry; executes nothing |
| `POST /mcp` | JSON-RPC; discovery/public reads available without a token, private tools authorized per caller |
| `GET`, `POST /connections`; `DELETE /connections/:id` | Owner-session connection management |
| `GET /inbox`, `POST /agent/chat` | Owner-session history and assistant |
| `GET /logo.svg`, `/brand/chainpay-icon.svg`, `/og-image.png` | Public brand assets for docs and link unfurlers |
| `GET /assets/brands/*` | Official token marks used on the docs page (USDC, Solana, PYUSD) |
| `GET /demo/store`, `POST /demo/store/requests` | Public Devnet demo merchant (Halden Data Co.): signs 10 and 25 USDC payment requests. Needs `CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT` |
| `GET /pay/<flowId>`, `GET /pay/<flowId>/status` | Public by unguessable link for 24 h: the live payment card opened by `open_payment`, as a page and as JSON. Holds only what the card shows |
| `GET /widget/preview?state=` | Payment card with labelled sample values, for design review |

### Payment card (MCP Apps)

After the owner says to pay a merchant-signed request, the agent calls
`open_payment`. That opens the ChainPay card in the chat (MCP Apps, or
`openai/outputTemplate` in ChatGPT) and returns a `flowUrl` that shows the same
card in a browser tab. Use the link for apps without cards, such as Codex in a
terminal. Opening the card moves no funds.

The agent then calls `execute_payment` and `wait_for_payment` with the card's
`flowId`. Each tool records the step it really reached: prepared, guardrails
passed, authorization and submission, then confirmation and receipt. The card
reveals recorded steps in order, never one before it is recorded. It reads them
from `/pay/<flowId>/status`. A card record holds only what the card shows,
belongs to the wallet that opened it, and expires after 24 hours (Convex
`payment_flows`, or PostgreSQL migration `0014_payment_flows.sql`). If storage
fails, the payment result is unchanged.

`quote_payment_request` shows the same card in its ready or blocked state.
Without `open_payment`, `execute_payment` behaves exactly as before. Set
`CHAINPAY_PUBLIC_MCP_URL` when the server is not hosted at
`https://chainpay-mcp.vercel.app`; the card's CSP allows requests to that
origin only.

Demo store environment:

| Variable | Purpose |
| --- | --- |
| `CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT` | The demo merchant's Devnet USDC token account (classic SPL Token). The store refuses to sign without it |
| `CHAINPAY_DEMO_MERCHANT_SECRET_KEY` | Keeps the merchant key, and therefore its displayed name, stable across serverless instances |

The [protocol reference](../docs/guides/connect-an-agent.md#protocol-reference)
describes supported versions, headers, discovery, and transport limitations.
The hosted page generates its tool catalog directly from
[src/tools/definitions.ts](src/tools/definitions.ts).

## Payment boundary

Owner management returns owner-signed transaction plans. `execute_payment` and
new `execute_x402_payment` operations require explicit `human` or `delegated`
signing mode. Human mode prepares or relays externally signed transactions;
delegated mode sends unsigned wires to Axum's mandate-bound provider signer.
MCP never accepts a private key or provider credential.

Only a relay answer of 400, 401, 403, 404 or 422 is reported as a rejection
(`backend_rejected`, `managed_backend_rejected`, or a thrown x402 error), as in
the dashboard. Any other non-OK answer, such as a 5xx or a gateway error page,
may arrive after the transaction was broadcast. Those return
`payment_pending` (or `x402_payment_pending`) with `status: "unknown"` and
the deterministic `payment_id` to resume with. Do not retry or sign a
replacement.

`prepare_token_accounts` lets the authenticated owner ask the assistant to
inspect one mint or every enabled registry asset. It returns at most one missing
ATA creation per call for explicit wallet review. After that transaction
confirms, call the tool again to prepare the next missing account. A scoped
agent connection cannot use this owner-management tool, and MCP never signs or
submits the returned transaction itself.

The x402 adapter supports ChainPay's custom `x402/1.0` receipt proof. Standard v2
is recognized and rejected before signing. See the
[custom x402 boundary](../docs/guides/connect-an-agent.md#custom-x402-boundary).
Code and fixture tests do not prove that a running deployment or signer provider
has accepted the complete flow.

## Crossmint staging connector

`prepare_crossmint_payment` reads an existing order from the fixed Crossmint
staging Orders API, checks the owner's mandate and exact quote, and returns a
wallet approval plus an `execute_crossmint_payment` continuation. Explicit
`preparePayer: true` on preparation lets an owner session request a payer PATCH;
ordinary preparation and all status retries only read the provider. No order
creation, purchase, or provider mutation was performed as implementation testing.

The feature defaults off. MCP and Axum both require
`CHAINPAY_CROSSMINT_ENABLED=true` for new checkout. Configure `CROSSMINT_API_KEY`
server-side in both services and the same random, at-least-32-character
`CHAINPAY_CROSSMINT_AUTH_SECRET` in both services. Never use Vite variables for
these credentials. The latter authenticates a short-lived provider preparation
bound to owner, mandate, agent, order, invoice and exact terms; a scoped caller
cannot fabricate Crossmint metadata and bypass the connector through Axum.

Current executable preparation is intentionally narrow: canonical Devnet USDC,
Solana staging, a valid unexpired matching quote, the mandate's exact source,
and Crossmint's real Solana preparation shape, which is exactly two
instructions in a legacy transaction with no lookup tables:

1. SPL Token `TransferChecked` from the payer's USDC account to Crossmint's
   treasury USDC account, for `transactionParameters.amount`. Every order pays
   the same treasury account (`8m5x…fCJuU` on staging), so the destination
   alone does not identify the order.
2. SPL Memo (`MemoSq4g…fcHr`) whose text is
   `------BEGIN MEMO------<JWT>------END MEMO------`. The only account it may
   name is the payer, as a signer.

**The memo rule.** The memo is the only link from a payment to its order, so
checkout requires it. `transactionParameters.memo` and the transaction's memo
must be byte-identical, at most 512 bytes, and the JWT payload's
`orderIdentifier` must equal the order id. ChainPay does not check the JWT
signature, which only Crossmint can verify. The memo is bound into the
reviewed terms, the `expectedTerms` fingerprint and the relay's HMAC payload;
a re-fetched order with a different memo needs a fresh owner review.

Crossmint's line items name the item through `metadata` and carry no
collection or template locator. Each line binds its name, description, image
URL, chain, quantity, execution mode, delivery wallet and line price, plus the
locator when Crossmint returns one. A missing or unreadable name or delivery
wallet fails closed. The owner review shows the item name.

ChainPay never submits Crossmint's transaction. It signs
`[execute_payment, memo]`: the unchanged mandate payment, then Crossmint's exact
memo as a top-level SPL Memo instruction that names **no** accounts. The agent
cannot sign as the payer, and the memo program accepts an unsigned memo.
Axum allows that second instruction only when the authorized Crossmint terms
bind that exact memo for that order. Every other payment keeps the
single-`execute_payment` rule. The receipt PDA and invoice hash are unchanged.

Other tokens, unchecked transfers, lookup tables, any other instruction, a
second memo and missing or changed terms fail closed. A newly required
provider instruction needs an explicitly reviewed adapter, not an
instruction-discarding fallback.

Resume `get_crossmint_payment` with the original relay `payment_id`. This never
prepares, signs or pays again and remains available if new checkout is disabled.
Axum independently reads provider status; supplied proof/phase fields are
ignored. Provider failures preserve confirmed settlement and report unknown
order status. The existing order claim is never automatically released.

`execute_crossmint_payment` reports `backend_rejected` only for relay answers
that prove nothing was broadcast (400, 401, 403, 404, 422), matching the
dashboard. Any other failure, such as a 5xx after the relay sent the
transaction, returns `crossmint_payment_pending` with `status: "unknown"` and
the deterministic `paymentId` to resume. Never retry or prepare a replacement.

Keep the server and `VITE_CHAINPAY_CROSSMINT` visibility flags off until the
operator has separately authorized and documented a staging acceptance payment:
matching final receipt, provider order advancement, and recovery evidence.
The provider's documented prepared-transaction workflow does not establish
that replacing its transfer with ChainPay CPI will be recognized. In the
mandate payment the token transfer is an inner (CPI) instruction, and its
authority and fee payer are not Crossmint's `payerAddress`. On the first Devnet acceptance payment
(2026-10-06) the order stayed `awaiting-payment` for five minutes after
finality and was credited 13 seconds after an explicit `crypto-tx-id`
notification, which the relay now sends (see the backend README). **Whether
Crossmint also detects such a payment on its own is unproven.** Passing local fixtures, including a real staging order response,
proves the software paths, not that provider compatibility assumption.

## Payment card evidence

The card distinguishes a refused new submission from the status of an existing
payment. Status-service failures remain unknown; a signed or previously paid
invoice never receives a claim that nothing was signed or that no funds moved.
Pending status reads use the backend's latest nested payment record. A failed
second quote preflight is blocked even if the initial requirements check passed.

Amounts require mint decimals read from chain. A request for a different mint
never displays the mandate's limits as though they were denominated in that token.
Updates retain descriptive fields only for the same payment ID; stale polling
responses cannot replace a newer card. Host runtime regression tests exercise
copying transaction signatures and replacing cards. These are simulated host
checks, not live ChatGPT/Claude or settlement acceptance.

## Verify changes

From the repository root:

```bash
npm run check:mcp
npm --prefix mcp-server run test
```

From this directory, `npm run check:mcp` and `npm run test` are aliases;
`npm run check` delegates to the full workspace check.

[All documentation](../docs/README.md) · [SDK](../sdk/README.md)
