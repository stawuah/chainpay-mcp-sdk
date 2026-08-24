# ChainPay backend

The backend is the reliability and orchestration boundary for ChainPay. It
provides APIs for the app and MCP server, submits Devnet transactions, tracks
confirmation, and stores non-sensitive off-chain metadata.

The backend must never override on-chain mandate policy, hold wallet keys, or
store seed phrases or raw private keys.

## Local checks

~~~bash
cargo test -p chainpay-backend
cargo run -p chainpay-backend
~~~

The backend accepts wallet-signed transactions only. It never receives a
private key or seed phrase. It validates the signed wire transaction, submits
it directly to Solana Devnet, waits for finalized status, verifies payment
receipts on-chain, and stores public lifecycle metadata with idempotency keys.

## Configuration

~~~bash
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_PROGRAM_ID=3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4 \
CHAINPAY_HTTP_PORT=8080 \
DATABASE_URL=postgresql://chainpay:chainpay@127.0.0.1:5432/chainpay \
cargo run -p chainpay-backend
~~~

The backend runs SQL migrations from `backend/migrations` during startup and
refuses to start without `DATABASE_URL`. In-memory storage is available only to
unit tests; production never falls back to ephemeral state.

Optional production settings include `CHAINPAY_HTTP_AUTH_TOKEN`,
`CHAINPAY_ALLOWED_ORIGINS`, `CHAINPAY_CONFIRMATION_TIMEOUT_SECS`, and
`CHAINPAY_CONFIRMATION_POLL_MS`.

## HTTP surface

- `GET /healthz` — backend, cluster, and program health.
- `GET /v1/config` — public runtime configuration.
- `POST /rpc` — authenticated, read-only Solana RPC proxy for the SDK.
- `GET /v1/rpc/latest-blockhash` — current Devnet blockhash.
- `POST /v1/transactions/submit` — validate, submit, and finalize any wallet-signed transaction.
- `GET /v1/transactions/:id` — transaction relay status.
- `POST /v1/payments` — validate, submit, finalize, verify the receipt, and persist a payment relay record.
- `GET /v1/payments/:id` — payment status and finalized signature.
- `GET /v1/receipts/:receipt_address` — persisted payment metadata for an on-chain receipt join.
- `POST /v1/x402-payments/proof` — persist the x402 proof retry outcome after confirmed settlement.
- `POST /v1/payment-requests/verify` — verify a merchant-signed Ed25519 payment request and derive its invoice hash.

The MCP server uses `CHAINPAY_BACKEND_URL` and
`CHAINPAY_BACKEND_AUTH_TOKEN` to call `/v1/payments` after a wallet or approved
signer has supplied a base64-encoded signed transaction. The on-chain program
remains the final policy authority.

The read-only RPC proxy and generic signed-transaction relay are intentionally
wallet-facing: the transaction signature is the authorization, so browsers do
not need a server secret. Configure `CHAINPAY_HTTP_AUTH_TOKEN` to protect the
MCP payment relay and other non-wallet API routes.
