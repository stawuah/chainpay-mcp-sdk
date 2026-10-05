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
| J1 last mile (receipt card, `/verify`, inbox archive, CTAs) | Closed | PR #22; shared `ReceiptCard`; landing **See a receipt** → demo Devnet receipt `/verify/7R1i…sh2q`; `/verify` accepts a pasted address or full receipt link; `/app/receipts/:pda` |
| J2 session safety (Back, false-empty, unknown routes, drafts, recovery copy) | Closed | PR #22 + #23; wallet-scoped in-memory drafts; inline settlement recovery (no doc-only dead end) |
| J3 MCP/outcomes (blocked vs approve, activity, x402 jobs) | Closed | PR #22; frontend tests 83/83 |
| J4a relay prerequisites | Closed | PR #22 (Kwasi review) |
| J4b object CRUD + delegate repair + ATA review + revoke chunking | Closed | PR #22 + #23; separate recipient ATA sign step; revoke-all tx chunking |
| J5 SDK honesty | Closed | PR #22 |
| J6a human send re-reads pause/revoke | Closed | PR #22 |
| J6b limits at payment | Addressed, pending deploy | Program writes a policy snapshot into each new receipt (upstream PR #23, open, not deployed). Until it deploys, the relay keeps a post-payment observation for receipts it sees settle (PR #25, labeled "Seen by the ChainPay relay after payment, not stored on Solana", owner session only). Receipt card section **Spending permission at payment** names its source; older receipts read "Not recorded" and show today's limits. Fixture and unit evidence only; no snapshot receipt exists on Devnet yet |
| J6c owner webhooks / email | **Blocked** | Settings → Notifications is read-only: “There is no webhook or email delivery in this build.” Future delivery is an Axum worker, not a missing Save button |
| J7 program asks | **Blocked** | Written asks only — listed below |
| J8 demo evidence | Partial | Readonly baseline USDC receipt PDA `7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q` loads on `/verify`; MCP/SDK control-layer shipped (x402 parsers in SDK, mandate quote on v2, MPP detect, agent skill, acceptance checklist in [acceptance-x402-mcp.md](../guides/acceptance-x402-mcp.md)); live signed MCP 402 → receipt still requires Dre authorization |
| DG1 purchase description | Addressed (off-chain) | Optional seller-signed `description` and `lineItems` in the payment request (PR #25). Shown to the owner, and on `/verify` only from an owner-shared audit link after it verifies against the invoice hash. Never invented; absent when the seller signed none |
| DG2 historical snapshot | Partial | New receipts carry a snapshot once PR #23 deploys; the relay observes receipts it settles after PR #25. No backfill for earlier receipts: they read "Not recorded" |
| PO purchase orders and budget requests | Addressed (off-chain), fixtures only | Signed mandate request links (`chainpay request-mandate` / `request-budget`, demo merchant **Request permission**) open a **PERMISSION REQUEST** card in Requests; **Review permission** prefills the existing builder (budget request: **Requester's agent signs**, `approvedAgent` = the request's agent); the accepted request is stored per permission (`PUT/GET /v1/mandates/{pda}/request`, migration 0011, owner only). Receipts show **Order match** (Matched / Payee differs / No invoice / No order); audit links can carry the order; CSV adds PO number and Order match; the permission panel has a **Statement**. The expected payee is **not enforced on Solana**: Matched is a check, not a guarantee. Harness and unit evidence only; no accepted request exists on Devnet yet |
| DG3 agent name | **Blocked** | Agent shown as address unless the program adds a name |

### Open program asks (Kwasi)

Do not implement until agreed:

1. **DuplicateInvoice**: handled off-chain. The SDK and relay refuse a payment whose receipt already exists with a typed `DuplicateInvoice` before anything is built or sent (PR #25). An on-chain error would need manual account creation in place of Anchor `init`; not planned for this build
2. **PaymentCountExceeded**: in upstream PR #23 (count overflow returns `PaymentCountExceeded`); open, not deployed
3. **On-chain receipt policy snapshot**: agreed; upstream PR #23, open, not deployed. The J6b relay observation is the fallback until then
4. Optional merchant-signed purchase memo/hash: covered off-chain by the signed request's optional description and line items, bound by the existing invoice hash (PR #25); no program change
5. Optional on-chain delivery attestation field: 32 reserved bytes in the PR #23 receipt layout; no field yet

Seller-facing copy remains **“Seller attests response served.”** until an approved on-chain field exists.

On 2026-09-15, the hosted landing showed an earlier interface, headed “The
universal rail for agent money.” Frontend and MCP/backend health endpoints
were reachable. The deployed commit and a new end-to-end payment were not
established by those checks. Use the local fork for the documented interface.
