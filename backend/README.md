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
private key or seed phrase. It simulates every transaction, submits it to
Solana Devnet, waits for finalized status, and stores public lifecycle metadata
with idempotency keys.

## Configuration

~~~bash
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_PROGRAM_ID=3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4 \
CHAINPAY_HTTP_PORT=8080 \
CHAINPAY_STATUS_FILE=./data/chainpay-status.json \
cargo run -p chainpay-backend
~~~

Optional production settings include `CHAINPAY_HTTP_AUTH_TOKEN`,
`CHAINPAY_ALLOWED_ORIGINS`, `CHAINPAY_CONFIRMATION_TIMEOUT_SECS`, and
`CHAINPAY_CONFIRMATION_POLL_MS`.

## HTTP surface

- `GET /healthz` — backend, cluster, and program health.
- `GET /v1/config` — public runtime configuration.
- `POST /rpc` — authenticated, read-only Solana RPC proxy for the SDK.
- `GET /v1/rpc/latest-blockhash` — current Devnet blockhash.
- `POST /v1/transactions/submit` — simulate, submit, and finalize any wallet-signed transaction.
- `GET /v1/transactions/:id` — transaction relay status.
- `POST /v1/payments` — simulate, submit, finalize, and persist a payment relay record.
- `GET /v1/payments/:id` — payment status and finalized signature.
- `POST /v1/payment-requests/verify` — verify a merchant-signed Ed25519 payment request and derive its invoice hash.

The MCP server uses `CHAINPAY_BACKEND_URL` and
`CHAINPAY_BACKEND_AUTH_TOKEN` to call `/v1/payments` after a wallet or approved
signer has supplied a base64-encoded signed transaction. The on-chain program
remains the final policy authority.

The read-only RPC proxy and generic signed-transaction relay are intentionally
wallet-facing: the transaction signature is the authorization, so browsers do
not need a server secret. Configure `CHAINPAY_HTTP_AUTH_TOKEN` to protect the
MCP payment relay and other non-wallet API routes.
