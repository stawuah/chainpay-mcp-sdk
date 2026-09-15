# ChainPay backend

Axum coordinates Devnet payment submission and PostgreSQL metadata. The program
remains the authority for spending; a wallet login never authorizes a payment.

## Configuration and checks

```bash
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_ALLOWED_ORIGINS=http://localhost:5173 \
DATABASE_URL=postgresql://chainpay:chainpay@127.0.0.1:5432/chainpay \
cargo run -p chainpay-backend

cargo test -p chainpay-backend
```

Startup applies `backend/migrations`, including `0006_owner_sessions.sql`.
Production requires PostgreSQL; in-memory storage is only for local tests.
Use explicit browser origins, including the scheme and port. `*` does not
permit wallet login. Session/challenge records and rate limits use the shared
PostgreSQL store; expired records are removed during authentication traffic.

Privy signing requires `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_POLICY_ID`
and the existing server-only `CHAINPAY_HTTP_AUTH_TOKEN` configuration. The
service token does **not** authorize any caller. Forward the actual owner
session or scoped connection bearer token to private endpoints. Never put
server credentials in Vite variables.

## Wallet sessions

1. `POST /v1/auth/challenge?wallet=<public-key>` (GET remains available to explicit-Origin clients) with an allowed `Origin` returns
   an exact login message, challenge ID, and five-minute expiry.
2. Sign that message with the wallet's `signMessage` operation.
3. `POST /v1/auth/session` with `{challenge_id, signature}` (base64 signature)
   and the same Origin atomically consumes the challenge and returns an opaque
   token with a one-hour expiry. Only its SHA-256 hash is persisted.
4. Send `Authorization: Bearer <token>` for private API calls.
5. `GET /v1/auth/session` introspects an owner session; `DELETE` revokes it.
   `GET /v1/auth/principal` also introspects scoped agent connections.

The frontend keeps the token in memory, renews expired sessions through a new
message signature, and clears/revokes it on wallet switch or disconnect.
Challenges are limited to 20 per direct peer and 1,000 globally per minute; login
attempts are limited to 200 per minute across instances. Caller-selected wallet
addresses do not consume another owner's allowance. Forwarding headers are not
trusted; configure requester limits at the trusted edge when sharing a reverse proxy.

## Authorization and routes

Public: `/healthz`, `/v1/config`, `/v1/rpc/latest-blockhash`, `/rpc`,
`POST /v1/delivery-attestations`, and
`GET /v1/delivery-attestations/{receiptAddress}`.
Trusted seller identities are public configuration (see
[trusted-sellers.md](../docs/trusted-sellers.md)); the signing secret never
enters this service. A missing or invalid seller statement does not change Paid.
The RPC proxy only forwards named read methods, bounds batches/history/body and
response sizes, and restricts program discovery to ChainPay with owner/mandate
filters (the asset registry uses its fixed account size).

Private endpoints derive the principal from a verified bearer credential:

- `/v1/managed-signers/challenge` and `/provision`: owner session, separate
  mandate-bound enrollment signature; `mint` and `mandate_nonce` bind the future
  PDA to the owner before provisioning, and existing mandates must belong to owner.
- `/v1/payments` and `/v1/managed-payments`: owned mandate and explicit
  `execute_payment` permission, or `execute_x402_payment` for x402 submissions.
- `/v1/payments/:id`, `/v1/receipts/:address`: owned/scoped mandate and
  `get_payment` or `wait_for_payment` permission.
- `/v1/x402-payments/proof`: `mandate`, idempotency key and
  `execute_x402_payment` permission are required.
- `/v1/transactions/submit`: owner-only mandate create+exact delegate approval,
  update, pause or revoke, homogeneous owner-signed payment batches (up to four),
  and revoke-all (up to 32; wire-size bound still applies). Every instruction
  and mandate is checked. Owner ATA setup is restricted to enabled ChainPay
  assets. Arbitrary signed transactions are rejected.
- `/v1/transactions/:id`: only the submitting owner can read its record.
- `/v1/payment-requests/verify`: owner session or permitted connection.

Connection scope is stored as a versioned JSON string in the existing scope
column: `{version:1, mandates:[...], tools:[...], agents:{mandate:agent}}`.
Every mandate is checked against current on-chain ownership and approved-agent
binding. Revoked or legacy `Unscoped` tokens cannot execute; reconnect them.
Payment idempotency is namespaced by verified wallet and mandate. Old opaque
transaction records without owner attribution are not readable through the
private relay status endpoint.

## Transaction versions and validation

Official published `solana-transaction =4.2.0`, `solana-message =4.6.0` and
`wincode 0.6` decode legacy/v0 and v1 wire layouts. Canonical re-encoding must
match the supplied bytes; provider-signed messages must equal the reviewed
unsigned message. Legacy/v0 are bounded to 1,232 bytes, v1 to 4,096 bytes.
Unresolved address-table transactions are rejected. Production builders remain
legacy.

Payment transactions contain exactly one execute-payment instruction. Every
account position, writable/signer role, fee payer, config/asset/receipt PDA,
agent, source, mint, recipient, token program and amount is checked. Unexpected
instructions, auxiliary transfers, extra accounts and duplicate accounts are
rejected. V1 requires explicit positive compute/data limits (at most 1,400,000
CU and 64 MiB), priority fee at most 100,000 lamports, and a valid bounded heap.
RPC submission uses preflight; confirmation and receipt verification still
follow submission.

Tests generate local fixture keys and never broadcast payments. The optional
`postgres_login_consumes_once_and_survives_store_reconnect` test uses an explicit
isolated localhost `TEST_DATABASE_URL`; it checks concurrent consumption through
independent pools, session persistence across store reconnects, and revocation.
It passed against a new local PostgreSQL fixture. This does not establish live
Devnet settlement or a production database restart drill.

Codec availability was checked on 2026-09-15 with `cargo info solana-transaction@4.2.0`
and `npm view @solana/transactions version`. See the [official Rust codec](https://docs.rs/solana-transaction/4.2.0/solana_transaction/versioned/struct.VersionedTransaction.html)
and [Solana v1 examples](https://github.com/solana-foundation/transaction-v1-examples).
