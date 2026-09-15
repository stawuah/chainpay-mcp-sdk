# ChainPay implementation status

Updated: 2026-09-15

This file separates implementation/regression evidence from real Devnet
settlement acceptance. Tests and local HTTP fixtures do not count as settlement.
PR01 enables RPC preflight after full wire validation. Axum then waits for
finality and verifies the receipt before reporting success. Local tests cover
wallet sessions, scope enforcement and official legacy/v0/v1 decoding; they
do not establish live settlement or a database restart acceptance.

| Workstream | Implementation | Current evidence | Real acceptance still required |
|---|---|---|---|
| Remove MCP settlement key | Complete | MCP starts without a secret key, rejects private-key-shaped arguments, and returns unsigned wire transactions | None for the server-key removal itself |
| PostgreSQL/Neon persistence | Code complete | Migrations `0001`-`0003` were previously applied; migration `0004` removes obsolete simulation columns and `0005` adds managed-signer metadata; production startup fails closed without `DATABASE_URL` | Start current Axum against Neon to apply `0005`, then submit an approved real payment, restart, and verify the persisted record |
| Preserve USDC/PYUSD | Complete regression gate | `npm run verify:devnet` confirms Devnet, deployed program, enabled registry PDAs, known successful transactions, exact token programs, and live capability profiles | One new approved settlement per changed token-program path before calling the changed settlement flow accepted |
| Token-2022 compatibility | Complete for current transparent path | Live PYUSD scan passes with zero fee and no active hook; unsupported/unknown transfer behavior fails closed; caller-supplied extension accounts are rejected | Each future fee/hook/memo/confidential adapter needs its own real Devnet fixture and acceptance transaction |
| Scalable asset registry | Complete implementation | SDK/MCP/dashboard enumerate all live `SupportedAsset` PDAs and the program enforces each mint/program binding | A new asset must be registered and settled on Devnet before that asset is accepted as live support; no registry mutation was performed merely for testing |
| x402 connector | Complete implementation | Live-fetch logic, external signer boundary, Axum relay, receipt verification, proof persistence, retry, shared canonical hash, and independent merchant are wired together | Explicitly approve/sign one real Devnet x402 payment and capture 402 → finalized receipt → 200 plus DB row |
| Receipt join | Complete implementation | MCP joins decoded on-chain receipt with Axum's PostgreSQL record by receipt PDA | Verify the join against the next approved real payment record; no fabricated settlement fixture is used as acceptance |
| Delegated wallet mode | Code complete; live provider configuration pending | Owner-signed, mandate-bound enrollment challenge; real Privy Solana wallet provisioning/signing adapter; metadata-only PostgreSQL registry; explicit human/delegated persistence; strict unsigned-wire and provider-signed-wire validation; MCP and dashboard paths are wired with no local-key fallback | Configure a Privy app, app secret, ChainPay-only policy ID, and matching Axum/MCP auth token; fund the provider signer with Devnet SOL; then explicitly approve one real delegated Devnet mandate and settlement before calling the flow accepted |
| PR-12 dependency maintenance | Lock + evidence complete | `qs` 6.16.0 and frontend `nanoid` 3.3.18 patched in-range; Anchor 1.1.2 assessed with no upgrade; residual `bigint-buffer` / `stream-json` / jayson `uuid` advisories documented | None for the lock refresh itself. Residual advisories stay tracked in [docs/dependency-advisories.md](../docs/dependency-advisories.md); they are not payment-path certification |

## PR-12 residual advisory disposition (2026-09-15)

Sources: GitHub Advisory Database pages dated in
[docs/dependency-advisories.md](../docs/dependency-advisories.md).
`npm audit fix --force` was not used.

- **Patched:** workspace `qs` 6.15.3 → 6.16.0 ([GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)); frontend transitive `nanoid` 3.3.16 → 3.3.18 ([GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8)). Nanoid did not wait on Astryx / PR-03.
- **Anchor 1.1.2:** assessed, no upgrade. 1.2.0 exists; no required payment-policy feature identified. Prior local lib/layout tests stand; no SBF/LiteSVM claim.
- **Retained:** `bigint-buffer@1.1.5` (no official patch; arrives via `@solana/buffer-layout-utils`); `stream-json@1.9.1` (jayson 1.x pin; patch is 3.5.0 major); jayson `uuid@8.3.2` (inspected `v4()` only; 11+ would be an untested major override). Post-refresh workspace audit: 9 nodes (3 high, 6 moderate). Frontend audit: 0.

No transaction was signed or submitted during this implementation session.
Known historical USDC and PYUSD transactions were queried read-only.
