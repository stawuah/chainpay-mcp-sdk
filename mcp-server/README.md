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
and exactly one TransferChecked instruction without extra reference accounts.
Other tokens, unchecked transfers, lookup tables, additional instructions and
missing/changed terms fail closed. A newly required provider instruction needs
an explicitly reviewed adapter, not an instruction-discarding fallback.

Resume `get_crossmint_payment` with the original relay `payment_id`. This never
prepares, signs or pays again and remains available if new checkout is disabled.
Axum independently reads provider status; supplied proof/phase fields are
ignored. Provider failures preserve confirmed settlement and report unknown
order status. The existing order claim is never automatically released.

Keep the server and `VITE_CHAINPAY_CROSSMINT` visibility flags off until the
operator has separately authorized and documented a staging acceptance payment:
matching final receipt, provider order advancement, and recovery evidence.
The provider's documented prepared-transaction workflow does not establish
that replacing its transfer with ChainPay CPI will be recognized. Passing local
fixtures proves the software paths, not that provider compatibility assumption.

## Verify changes

From the repository root:

```bash
npm run check:mcp
npm --prefix mcp-server run test
```

From this directory, `npm run check:mcp` and `npm run test` are aliases;
`npm run check` delegates to the full workspace check.

[All documentation](../docs/README.md) · [SDK](../sdk/README.md)
