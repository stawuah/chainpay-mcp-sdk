# ChainPay implementation status

Updated: 2026-08-25

This file separates implementation/regression evidence from real Devnet
settlement acceptance. Tests and local HTTP fixtures do not count as settlement.
Runtime transaction paths do not call Solana transaction simulation: Axum
validates signed wire bytes, submits directly to Devnet, waits for finality, and
verifies the payment receipt before reporting success.

| Workstream | Implementation | Current evidence | Real acceptance still required |
|---|---|---|---|
| Remove MCP settlement key | Complete | MCP starts without a secret key, rejects private-key-shaped arguments, and returns unsigned wire transactions | None for the server-key removal itself |
| PostgreSQL/Neon persistence | Code complete | Migrations `0001`-`0003` were previously applied; migration `0004` removes obsolete simulation columns and `0005` adds managed-signer metadata; production startup fails closed without `DATABASE_URL` | Start current Axum against Neon to apply `0005`, then submit an approved real payment, restart, and verify the persisted record |
| Preserve USDC/PYUSD | Complete regression gate | `npm run verify:devnet` confirms Devnet, deployed program, enabled registry PDAs, known successful transactions, exact token programs, and live capability profiles | One new approved settlement per changed token-program path before calling the changed settlement flow accepted |
| Token-2022 compatibility | Complete for current transparent path | Live PYUSD scan passes with zero fee and no active hook; unsupported/unknown transfer behavior fails closed; caller-supplied extension accounts are rejected | Each future fee/hook/memo/confidential adapter needs its own real Devnet fixture and acceptance transaction |
| Scalable asset registry | Complete implementation | SDK/MCP/dashboard enumerate all live `SupportedAsset` PDAs and the program enforces each mint/program binding | A new asset must be registered and settled on Devnet before that asset is accepted as live support; no registry mutation was performed merely for testing |
| x402 connector | Standard human-signing route implemented; live acceptance pending | MCP validates standard x402 v2 `exact` challenges, builds a direct verified SPL/Token-2022 transfer, pins Corbits, validates its `/supported` response, retries with `PAYMENT-SIGNATURE`; the independent merchant calls the facilitator and Axum persists `PAYMENT-RESPONSE` | Corbits must be reachable and advertise the chosen Devnet asset; explicitly approve/sign one payment and capture 402 → PAYMENT-SIGNATURE → Corbits transaction → 200 plus DB row. No delegated x402 claim yet. |
| Receipt join | Complete implementation | MCP joins decoded on-chain receipt with Axum's PostgreSQL record by receipt PDA | Verify the join against the next approved real payment record; no fabricated settlement fixture is used as acceptance |
| Delegated wallet mode | Code complete; live provider configuration pending | Owner-signed, mandate-bound enrollment challenge; real Privy Solana wallet provisioning/signing adapter; metadata-only PostgreSQL registry; explicit human/delegated persistence; strict unsigned-wire and provider-signed-wire validation; MCP and dashboard paths are wired with no local-key fallback | Configure a Privy app, app secret, ChainPay-only policy ID, and matching Axum/MCP auth token; fund the provider signer with Devnet SOL; then explicitly approve one real delegated Devnet mandate and settlement before calling the flow accepted |

No transaction was signed or submitted during this implementation session.
Known historical USDC and PYUSD transactions were queried read-only.
