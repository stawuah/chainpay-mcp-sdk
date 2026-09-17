# ChainPay implementation status

Updated: 2026-09-16

This file separates implementation/regression evidence from real Devnet
settlement acceptance. Tests and local HTTP fixtures do not count as settlement.
PR01 enables RPC preflight after full wire validation. Axum then waits for
finality and verifies the receipt before reporting success. Local tests cover
wallet sessions, scope enforcement and official legacy/v0/v1 decoding; they
do not establish live settlement or a database restart acceptance.

| Workstream | Implementation | Current evidence | Real acceptance still required |
|---|---|---|---|
| Remove MCP settlement key | Complete | MCP starts without a secret key, rejects private-key-shaped arguments, and returns unsigned wire transactions | None for the server-key removal itself |
| PostgreSQL/Neon persistence | Code complete | Historical evidence records migrations `0001`–`0003` applied. Current startup includes `0001`–`0008`, including wallet sessions, recovery claims, and seller statements; their deployment/application state must be checked. Production startup fails closed without `DATABASE_URL` | Verify all current migrations through `0008` in the target deployment, then submit an explicitly approved payment, restart, and read the original persisted record |
| Preserve USDC/PYUSD | Complete regression gate | `npm run verify:devnet` confirms Devnet, deployed program, enabled registry PDAs, known successful transactions, exact token programs, and live capability profiles | One new approved settlement per changed token-program path before calling the changed settlement flow accepted |
| Token-2022 compatibility | Complete for current transparent path | Live PYUSD scan passes with zero fee and no active hook; unsupported/unknown transfer behavior fails closed; caller-supplied extension accounts are rejected | Each future fee/hook/memo/confidential adapter needs its own real Devnet fixture and acceptance transaction |
| Scalable asset registry | Complete implementation | SDK/MCP/dashboard enumerate all live `SupportedAsset` PDAs and the program enforces each mint/program binding | A new asset must be registered and settled on Devnet before that asset is accepted as live support; no registry mutation was performed merely for testing |
| x402 connector | Complete implementation | Live-fetch logic, external signer boundary, Axum relay, receipt verification, proof persistence, retry, shared canonical hash, and independent merchant are wired together | Explicitly approve/sign one real Devnet x402 payment and capture 402 → finalized receipt → 200 plus DB row |
| Receipt join | Complete implementation | MCP joins decoded on-chain receipt with Axum's PostgreSQL record by receipt PDA | Verify the join against the next approved real payment record; no fabricated settlement fixture is used as acceptance |
| Delegated wallet mode | Code complete; live provider configuration pending | Owner-signed, mandate-bound enrollment challenge; real Privy Solana wallet provisioning/signing adapter; metadata-only PostgreSQL registry; explicit human/delegated persistence; strict unsigned-wire and provider-signed-wire validation; MCP and dashboard paths are wired with no local-key fallback | Configure a Privy app, app secret, ChainPay-only policy ID, and matching Axum/MCP auth token; fund the provider signer with Devnet SOL; then explicitly approve one real delegated Devnet mandate and settlement before calling the flow accepted |
| PR-12 dependency maintenance | Lock + evidence complete | `qs` 6.16.0 and frontend `nanoid` 3.3.18 patched in-range; Anchor 1.1.2 assessed with no upgrade; residual `bigint-buffer` / `stream-json` / jayson `uuid` advisories documented | None for the lock refresh itself. Residual advisories stay tracked in [Dependency advisories](dependency-advisories.md); they are not payment-path certification |

## PR-12 residual advisory disposition (2026-09-15)

Sources: GitHub Advisory Database pages dated in
[Dependency advisories](dependency-advisories.md).
`npm audit fix --force` was not used.

- **Patched:** workspace `qs` 6.15.3 → 6.16.0 ([GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)); frontend transitive `nanoid` 3.3.16 → 3.3.18 ([GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8)). Nanoid did not wait on Astryx / PR-03.
- **Anchor 1.1.2:** assessed, no upgrade. 1.2.0 exists; no required payment-policy feature identified. Prior local lib/layout tests stand; no SBF/LiteSVM claim.
- **Retained:** `bigint-buffer@1.1.5` (no official patch; arrives via `@solana/buffer-layout-utils`); `stream-json@1.9.1` (jayson 1.x pin; patch is 3.5.0 major); jayson `uuid@8.3.2` (inspected `v4()` only; 11+ would be an untested major override). Post-refresh workspace audit: 9 nodes (3 high, 6 moderate). Frontend audit: 0.

No transaction was signed or submitted during the implementation checks recorded above.
Known historical USDC and PYUSD transactions were queried read-only.

## Owner journey close (fork stack PR #22 + #23)

Evidence is regression, browser, and readonly Devnet receipt reads unless noted.
Stack: `dre/pr-20-owner-onboarding` → `dre/journey-close-j1` (#22) →
`dre/journey-close-remaining` (#23).

| Journey slice | Status | Evidence |
|---|---|---|
| J1 last mile (receipt card, `/verify`, inbox archive, CTAs) | Closed | PR #22; shared `ReceiptCard`; landing **See a receipt** → `/verify`; `/app/receipts/:pda` |
| J2 session safety (Back, false-empty, unknown routes, drafts, recovery copy) | Closed | PR #22 + #23; wallet-scoped in-memory drafts; inline settlement recovery (no doc-only dead end) |
| J3 MCP/outcomes (blocked vs approve, activity, x402 jobs) | Closed | PR #22; frontend tests 83/83 |
| J4a relay prerequisites | Closed | PR #22 (Kwasi review) |
| J4b object CRUD + delegate repair + ATA review + revoke chunking | Closed | PR #22 + #23; separate recipient ATA sign step; revoke-all tx chunking |
| J5 SDK honesty | Closed | PR #22 |
| J6a human send re-reads pause/revoke | Closed | PR #22 |
| J6b public policy observation | **Blocked** | Kwasi-owned Axum worker; public card shows **current** mandate limits with honest labeling |
| J6c owner webhooks / email | **Blocked** | Settings → Notifications is read-only: “There is no webhook or email delivery in this build.” Future delivery is an Axum worker, not a missing Save button |
| J7 program asks | **Blocked** | Written asks only — listed below |
| J8 demo evidence | Partial | Readonly baseline USDC receipt PDA `7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q` loads on `/verify`; new signed demo requires Dre authorization |
| DG1–DG3 data gaps | **Blocked** | No invented purchase description, no historical snapshot backfill, agent shown as address unless program adds a name |

### Open program asks (Kwasi)

Do not implement until agreed:

1. **DuplicateInvoice** custom error for reused invoice hashes
2. **PaymentCountExceeded** instead of overflow panic on count increment
3. Optional on-chain receipt policy snapshot (alternative: J6b off-chain observation — pick one)
4. Optional merchant-signed purchase memo/hash
5. Optional on-chain delivery attestation field

Seller-facing copy remains **“Seller attests response served.”** until an approved on-chain field exists.

On 2026-09-15, the hosted landing showed an earlier interface, headed “The
universal rail for agent money.” Frontend and MCP/backend health endpoints
were reachable. The deployed commit and a new end-to-end payment were not
established by those checks. Use the local fork for the documented interface.
