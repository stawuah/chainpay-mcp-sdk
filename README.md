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
app/                             Wallet-connected operations dashboard boundary
docs/scope.md                    Authoritative ChainPay scope
~~~

The root Cargo workspace contains the backend and ChainPay program. Connectors,
confidential transfers, MEV reduction, and production payment integrations are
outside the MVP.

The contract accepts a bounded allowlist of up to three settlement mints. Its
transfer CPI uses Anchor's `TokenInterface`, so the same policy path supports
classic SPL Token and Token-2022 accounts. Devnet uses custom demonstration
mints; production USDC and PYUSD addresses are configured per deployment.

## Setup and checks

From the repository root:

~~~bash
npm install
make check
make test
make build
make start-backend
~~~

The dashboard scaffold can be invoked with:

~~~bash
make app-dev
~~~

The current app command is a placeholder and does not start an HTTP UI yet.
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
~~~

The MCP server speaks standard JSON-RPC MCP over stdio and exposes
`get_mandate`, `create_mandate`, `prepare_payment`, `execute_payment`,
`get_payment`, `pause_mandate`, and `revoke_mandate`. Any MCP-capable LLM
client can discover these tools. Owner actions return wallet-signature plans;
payment execution requires an injected `PaymentSubmissionAdapter`, so the MCP
process never stores a private key.

Set `CHAINPAY_RPC_URL` and optionally `CHAINPAY_PROGRAM_ID` before starting it:

~~~bash
CHAINPAY_RPC_URL=https://api.devnet.solana.com npm --prefix mcp-server run dev
~~~

The SDK performs PDA derivation, account decoding, token-program detection,
instruction construction, duplicate-receipt checks, simulation, and status
handling. The on-chain program remains the final authority for every payment.

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
- The SDK, MCP server, backend, and app must never store private keys or seed
  phrases.

See [docs/scope.md](docs/scope.md) for the authoritative product, technical,
and delivery scope.
