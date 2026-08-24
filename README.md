# ChainPay

ChainPay is an agentic, policy-controlled stablecoin payment protocol on
Solana. It is a payment rail for AI agents, applications, and MCP servers; it
is not an AI agent and never receives a user's private key.

## Layout

~~~
programs/chainpay/               Anchor policy and payment program
sdk/                             TypeScript mandate/payment SDK
mcp-server/                      Safe agent/MCP tool boundary
backend/                         RPC, status, API, and storage boundary
frontend/                        Wallet-connected React dashboard
demo-merchant/                   Independent x402 resource/receipt verifier
backend/migrations/              PostgreSQL/Neon schema migrations
app/                             Lightweight UI contract scaffold
docs/scope.md                    Authoritative ChainPay scope
~~~

The root Cargo workspace contains the backend and ChainPay program. Connectors,
confidential transfers, MEV reduction, and production payment integrations are
outside the MVP.

The protocol authority registers an explicit allowlist of settlement mint
accounts. Each `SupportedAsset` entry binds one mint to either classic SPL Token
or Token-2022. Payment preparation then inspects the live mint, source, and
recipient accounts and fails closed for unsupported transfer-affecting
extensions. Devnet retains the existing USDC classic-SPL and PYUSD Token-2022
registry entries and known confirmed settlement baselines.

## Setup and checks

From the repository root:

~~~bash
npm install
make check
make test
make build
make start-backend
~~~

The dashboard can be invoked with:

~~~bash
make frontend-dev
~~~

The original `app/` package remains a lightweight page/component contract
scaffold; the runnable React dashboard is in `frontend/`.
Contract-specific checks use `make contract-check`. With the matching Anchor
1.1.2 CLI, `make contract-build` produces the SBF artifact and generates
`target/idl/chainpay.json` plus `target/types/chainpay.ts`. `make contract-smoke`
then runs the classic SPL Token and Token-2022 settlement tests in LiteSVM.

If AVM cannot switch the selected binary automatically, set the CLI explicitly,
for example:

~~~bash
make ANCHOR=/home/stephen/.avm/bin/anchor-1.1.2 contract-smoke
~~~

## Universal MCP and SDK

The TypeScript SDK and MCP server are now usable independently of the UI:

~~~bash
npm run check
npm --prefix sdk run test
npm --prefix mcp-server run test
npm run verify:devnet
~~~

With Axum, HTTP MCP, the independent merchant, and Neon running, verify their
real connections together:

~~~bash
CHAINPAY_BACKEND_URL=https://backend.example.com \
CHAINPAY_MCP_URL=https://mcp.example.com/mcp \
CHAINPAY_X402_RESOURCE_URL=https://merchant.example.com/data \
DATABASE_URL='postgresql://...' \
npm run verify:stack
~~~

This verifier is read-only. It checks Axum-to-Devnet RPC, MCP live asset and
receipt reads, the merchant's real 402 and Devnet receipt lookup, and the Neon
schema. It does not fabricate or broadcast a payment.

The MCP server speaks standard JSON-RPC MCP over stdio and exposes protocol
configuration and asset discovery, mandate lifecycle, payment quote/preflight,
merchant-signed request verification, x402 challenge preparation, signed
payment relay, and receipt/status tools. Any MCP-capable LLM client can
discover these tools. Owner actions return wallet-signature plans; payment
execution returns an unsigned wire transaction for a browser wallet or external
agent runtime. MCP can relay only an already signed transaction, so the MCP
process never stores a settlement private key.

Set `CHAINPAY_RPC_URL` and optionally `CHAINPAY_PROGRAM_ID` before starting it:

~~~bash
CHAINPAY_RPC_URL=https://api.devnet.solana.com npm --prefix mcp-server run dev
~~~

The SDK performs PDA derivation, account decoding, token-program detection,
registry discovery, Token-2022 capability inspection, instruction construction,
duplicate-receipt checks, and status handling. Axum submits an externally signed
transaction directly to Devnet, waits for finality, and verifies its receipt.
The on-chain program remains the final authority for every payment.

Axum and the HTTP MCP service require `DATABASE_URL` and run the migrations in
`backend/migrations`. Production does not fall back to an in-memory status
store. The x402 verifier in `demo-merchant/` returns 402, independently checks a
finalized receipt and its transaction, and releases the resource only after the
proof matches.

Render deployment is defined in [render.yaml](render.yaml). It runs the MCP
server as a native Node web service with `/healthz` health checks and `/mcp` as
the remote MCP endpoint.

## Architecture guardrails

- Critical payment policy is enforced on-chain.
- The user remains the owner of funds.
- The agent only spends through an approved mandate and limited delegate.
- Every successful payment creates a durable receipt.
- Supported token accounts must use the configured mint and the same token
  program as the mint.
- Tests are regression checks only. Live success is reported only from a
  finalized Devnet transaction and a verified on-chain receipt.
- The SDK, MCP server, backend, and app must never store private keys or seed
  phrases.

See [docs/scope.md](docs/scope.md) for the authoritative product, technical,
and delivery scope.
