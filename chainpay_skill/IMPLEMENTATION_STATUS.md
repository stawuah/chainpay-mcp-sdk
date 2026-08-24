# ChainPay implementation status

Updated: 2026-08-24

This file separates implementation/regression evidence from real Devnet
settlement acceptance. Tests and local HTTP fixtures do not count as settlement.
Runtime transaction paths do not call Solana transaction simulation: Axum
validates signed wire bytes, submits directly to Devnet, waits for finality, and
verifies the payment receipt before reporting success.

| Workstream | Implementation | Current evidence | Real acceptance still required |
|---|---|---|---|
| Remove MCP settlement key | Complete | MCP starts without a secret key, rejects private-key-shaped arguments, and returns unsigned wire transactions | None for the server-key removal itself |
| PostgreSQL/Neon persistence | Code complete | Migrations `0001`-`0003` were previously applied; migration `0004` removes obsolete simulation columns; production startup fails closed without `DATABASE_URL` | Start current Axum against Neon to apply `0004`, then submit an approved real payment, restart, and verify the persisted record |
| Preserve USDC/PYUSD | Complete regression gate | `npm run verify:devnet` confirms Devnet, deployed program, enabled registry PDAs, known successful transactions, exact token programs, and live capability profiles | One new approved settlement per changed token-program path before calling the changed settlement flow accepted |
| Token-2022 compatibility | Complete for current transparent path | Live PYUSD scan passes with zero fee and no active hook; unsupported/unknown transfer behavior fails closed; caller-supplied extension accounts are rejected | Each future fee/hook/memo/confidential adapter needs its own real Devnet fixture and acceptance transaction |
| Scalable asset registry | Complete implementation | SDK/MCP/dashboard enumerate all live `SupportedAsset` PDAs and the program enforces each mint/program binding | A new asset must be registered and settled on Devnet before that asset is accepted as live support; no registry mutation was performed merely for testing |
| x402 connector | Complete implementation | Live-fetch logic, external signer boundary, Axum relay, receipt verification, proof persistence, retry, shared canonical hash, and independent merchant are wired together | Explicitly approve/sign one real Devnet x402 payment and capture 402 → finalized receipt → 200 plus DB row |
| Receipt join | Complete implementation | MCP joins decoded on-chain receipt with Axum's PostgreSQL record by receipt PDA | Verify the join against the next approved real payment record; no fabricated settlement fixture is used as acceptance |
| Delegated wallet mode | Managed-signer redesign in progress | Browser key generation/export and the customer-facing public-address paste field have been removed; automatic payments remain disabled until real provisioning exists, while the on-chain `approved_agent` boundary remains intact | Add signed owner authentication, provider provisioning/signing, metadata-only PostgreSQL registry, then explicitly approve one real delegated Devnet mandate and settlement before calling the flow accepted |

No transaction was signed or submitted during this implementation session.
Known historical USDC and PYUSD transactions were queried read-only.
