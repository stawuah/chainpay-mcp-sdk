# ChainPay implementation status

Updated: 2026-10-06, against upstream master `ddcd7c2`. "Live on Devnet,
2026-10-06" is the newest record. "Current state at master `c936067`" is the
2026-10-05 record, kept as it was except for the PR status column. The tables
after it are the 2026-09-16 record; rows that changed since are marked.

This file separates implementation/regression evidence from real Devnet
settlement acceptance. Tests and local HTTP fixtures do not count as settlement.
PR01 enables RPC preflight after full wire validation. Axum then waits for
finality and verifies the receipt before reporting success. Local tests cover
wallet sessions, scope enforcement and official legacy/v0/v1 decoding; they
do not establish live settlement or a database restart acceptance.

## Live on Devnet, 2026-10-06

### Merged since the 2026-10-05 record

`gh pr list -R stawuah/chainpay-mcp-sdk --state all`, read 2026-10-06:

| PR | What | Merged (UTC) | Merge commit |
| --- | --- | --- | --- |
| [#52](https://github.com/stawuah/chainpay-mcp-sdk/pull/52) | Card activation is "on" only after the public commitment | 2026-10-05 06:52 | `2c09de1` |
| [#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53) | Receipts a stranger can open, honest captions | 2026-10-05 06:58 | `371b9c4` |
| [#54](https://github.com/stawuah/chainpay-mcp-sdk/pull/54) | PayPal v2 proposal and site copy (nothing built) | 2026-10-05 06:59 | `b03e63c` |
| [#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55) | Crossmint binds the delivery recipient; refunds never read as delivered | 2026-10-05 07:03 | `2853ff0` |
| [#56](https://github.com/stawuah/chainpay-mcp-sdk/pull/56) | Support tips: Devnet only, fail closed | 2026-10-05 07:00 | `f182dfa` |
| [#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57) | Owner webhooks, off unless `OWNER_WEBHOOKS_ENABLED=true` | 2026-10-05 09:55 | `6c0fb88` |
| [#58](https://github.com/stawuah/chainpay-mcp-sdk/pull/58) | This status page and the release manifest | 2026-10-05 09:56 | `186bb54` |
| [#59](https://github.com/stawuah/chainpay-mcp-sdk/pull/59) | Crossmint order memo carried in the mandate payment | 2026-10-05 15:21 | `a9a023a` |
| [#60](https://github.com/stawuah/chainpay-mcp-sdk/pull/60) | `@chainpayhq/sdk` 0.1.0 npm release prep | 2026-10-06 00:55 | `dffa44a` |
| [#61](https://github.com/stawuah/chainpay-mcp-sdk/pull/61) | Crossmint fixes from the live run, incl. the relay's `crypto-tx-id` notice | 2026-10-06 14:41 | `ecfc2d0` |
| [#62](https://github.com/stawuah/chainpay-mcp-sdk/pull/62) | Card setup works in Phantom; stopped setups can finish | 2026-10-06 14:54 | `ddcd7c2` |

Still open: [#63](https://github.com/stawuah/chainpay-mcp-sdk/pull/63) (card
repayment against the deployed 282-byte ChainPay receipt; SDK accepts
MagicBlock's new deposit shape) and
[#64](https://github.com/stawuah/chainpay-mcp-sdk/pull/64) (x402 job labels,
demo merchant `payTo`, hostable demo merchant, webhook redeliver cleanup).

### What was proven, and where

All runs used Devnet test tokens, the Lithic **sandbox** and Crossmint
**staging**, against **preview** deploys of the relay and MCP with preview
Convex `acrobatic-mole-703`. Production env was not changed by any run, so
"proven on Devnet" below does not mean switched on in production. Full
evidence: the [release manifest's 2026-10-06 record](release-manifest.md#devnet-live-runs-2026-10-06).

| Capability | Live-proven on Devnet | Evidence | Still needed before production says "on" |
| --- | --- | --- | --- |
| Agent cards: activation, approve, decline, freeze | **Yes**, 2026-10-06, preview relay at `dffa44a` | Commitment [`DAHX…SZXX`](https://explorer.solana.com/address/DAHXQq6MA5MNz2KWRSEEfdoAh1RNFMuJwURwaLt2SZXX?cluster=devnet) read back (seq 1) before Lithic showed OPEN. $20 approved (Lithic auth `e73796bf…`), $40 refused by the private rules and declined at the network (`d5f273de…`), freeze read back PAUSED. TEE attestation `enforce`, DCAP verified | Relay `CARDS_CHECKOUT_ENABLED` + `CARDS_CHECKOUT_RUNNER_SECRET` (production declines every purchase with `intent_missing` without them); repo var `CARDS_RECONCILE_URL` + secret `CARDS_CRON_SECRET` |
| Agent cards: `CARDS_NEW_ACTIVATION_ENABLED=false` | **Yes**, 2026-10-06, preview | prepare and activate → 503 `new_activation_disabled`; reads, freeze, repayment, reconcile → 200 | — |
| Card statement repayment, transparent | **Yes**, 2026-10-06 | `repay_statement` [`2xjwgS6X…`](https://explorer.solana.com/tx/2xjwgS6XAS59255knTXpDzHSovdc5gVGnpnW2fK9nmGVodrvke5rLm2FGqnQvcS72MmA2s8z44Ub7tpbQCFLvQs3?cluster=devnet) → ChainPay receipt [`5gFw…7pP7`](https://explorer.solana.com/address/5gFweJeBTjuR3kkqWSegXWSPEWiHkTJp3diKF9Za7pP7?cluster=devnet), statement discharged on PER. Needed the `card_policy` upgrade (Devnet slot 508123988, built from #63) | Merge #63, so master matches the upgraded program |
| Card statement repayment, private (MagicBlock) | **Yes**, 2026-10-06 | Deposit [`3YyV8ndz…`](https://explorer.solana.com/tx/3YyV8ndzAigTFDs1pvHQ6sqG1CrQBs7QDxZDdvc7CrZ6ttBTu3dXGDbZhxuhKTTTkta17NsiWc5z1jPiuVgNuwWG?cluster=devnet), settlement [`3L7HAjDm…`](https://explorer.solana.com/tx/3L7HAjDmGNjtZWN5KNCGgzQKi9theqqEn9VekPtsEtq6jqFHKQctqqBideAgk8zpMLUwWKT13XgkKApUVDDvhrgz?cluster=devnet), labeled `payerVerified: false` / "Simulated credit", discharged | Merge #63 (SDK accepts deposit tag 24) |
| Standard x402 v2 (receipt-merchant path) | **Yes**, 2026-10-06, preview relay + MCP at `dffa44a` | 402 → payment [`2nGaP5WS…`](https://explorer.solana.com/tx/2nGaP5WSqtgkVutuoJXiNXkR9wPvDFARt24LrtNoWdhVJ8peDFtB3QooRtqi574Mk7cfZehRtmqZrMkhZfdXLRDQ?cluster=devnet) → receipt [`Fqn1…ZtZV`](https://explorer.solana.com/address/Fqn1y5q7dGvtFM49xGpZXFfsmdtRpm9ENPDtZHBnZtZV?cluster=devnet) → 200. Replays: `duplicate_invoice` or the same receipt, no second payment | MCP `CHAINPAY_X402_ALLOWED_ORIGINS` / `_RECEIPT_MERCHANTS` in production; #64 for job labels |
| Owner webhooks | **Yes on preview**, 2026-10-06 | Signed `payment.receipt_ready` `evt_0425bf41…`, 5 deliveries all verified; 500 / 429 / timeout retried with the same event ID; concurrent dispatchers did not double-deliver | Relay `OWNER_WEBHOOKS_*`, `CRON_SECRET`, `CHAINPAY_APP_URL`; repo var + secret for the scheduled dispatch, then one green scheduled run |
| Crossmint checkout | **Paid and credited on staging, with a caveat**, 2026-10-06 | Order `5a5fe611…` paid by [`AsCF3JLh…`](https://explorer.solana.com/tx/AsCF3JLhHxtuYNiu82KqJW8epaKWiF7sWmYujLfsMgbsqyxkiutGmr6Ag7YmsSxoeZHEFymko6fJ4T1MvMpWaEx?cluster=devnet) (0.1203 Devnet USDC). Crossmint marked it paid only after a manual `crypto-tx-id` call. Delivery never finished | One Devnet re-run on a preview built after #61 (relay sends `crypto-tx-id` itself); then the three flags. The use case stays Coming soon |
| Managed (Privy) signing | Not run | — | One approved delegated Devnet payment |
| PayPal invoices, support tips | Not run (not built / not deployed) | — | Out of scope for this round |

Bugs these runs found are fixed in #61 and #62 (merged) and #63 and #64 (open).

## Current state at master `c936067` (2026-10-05)

Each capability has three separate states. They are not steps of one scale:

- **In master**: the code is on upstream `master` at `c936067af6c8c34d33c65a06f5f0119a405178f6`.
- **Deployed**: a public check shows that code serving. "Unverified" means nobody
  outside the hosting accounts can confirm it, usually because it depends on an
  environment flag. It does not mean "off".
- **Live-proven**: an end-to-end run on the deployed release, with a link to its
  evidence. A passing test, a fixture, or a health endpoint is never live proof.

Read-only checks used on 2026-10-05:

- The [Deploy to Vercel run 37219312021](https://github.com/stawuah/chainpay-mcp-sdk/actions/runs/37219312021)
  (2026-10-04) deployed `c936067`. It pushed Convex functions to `notable-bee-447`,
  then the relay, MCP and web projects. All four jobs succeeded. A later manual
  Vercel deploy would not show here, so this is the last *workflow* deploy.
- `GET https://chainpay-relay.vercel.app/healthz` reports Devnet, program
  `3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4` and `managed_signing: privy`.
- MCP `tools/list` at `https://chainpay-mcp.vercel.app/mcp` returns 33 tools.
- Devnet RPC: the ChainPay program data was last deployed at slot `484104138`
  (2026-08-15). The program owns 26 receipt accounts of 282 bytes (original
  layout) and **0** of 371 bytes (layout with the policy snapshot).

| Capability | In master | Deployed | Live-proven | Pending |
| --- | --- | --- | --- | --- |
| Spending permissions: create, update, pause, revoke, on-chain limits | Yes | Program on Devnet since 2026-08-15; web and relay from run 37219312021 | Historical Devnet settlements [USDC](https://explorer.solana.com/tx/6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D?cluster=devnet) and [PYUSD](https://explorer.solana.com/tx/3yRhnwna13r5SDUsBf2LJdgqGRro7XAGZtaPHbAARfMLbCmQyFS8BWXdyK6qdtpZ48mpc2srvt2UU7LZ63vBLc7?cluster=devnet), both from before this release. Not yet proven on `c936067` | — |
| Payment receipt PDA and public `/verify` card | Yes | Web from run 37219312021 | Receipt account [`7R1i…sh2q`](https://explorer.solana.com/address/7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q?cluster=devnet) exists (282 bytes, 0.010000 USDC). The public site's card for it has not been recorded | [#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53) (merged 2026-10-05): landing opens that receipt; honest captions |
| Policy snapshot stored at payment (371-byte receipt) | Yes: program change [#23](https://github.com/stawuah/chainpay-mcp-sdk/pull/23) (`c9f9663`), readers in SDK and web | **No.** The Devnet program predates the change and no 371-byte receipt exists | Not yet proven | Program upgrade (Kwasi). Caption honesty in #53 |
| Relay-observed limits (read after payment) | Yes | Relay from run 37219312021 | Not yet proven | #53 relabels it "read after payment" |
| MCP server, 33 tools | Yes | `tools/list` returns 33 | Discovery only. No tool-driven payment recorded on this release | [#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55) (merged 2026-10-05) changes Crossmint tool output, not the count |
| Custom x402: 402 → mandate payment → receipt → 200 | Yes | Relay and MCP from run 37219312021 | Not yet proven. Use the [x402 acceptance checklist](../guides/acceptance-x402-mcp.md) | — |
| Standard x402 v2 | Quoted; settles only for `CHAINPAY_X402_RECEIPT_MERCHANTS` | Unverified (env) | Not yet proven | — |
| Delegated (Privy) signing | Yes | `healthz` reports `privy` | Not yet proven | — |
| Vercel + Convex storage | Yes | Convex `notable-bee-447` functions and services from run 37219312021 | Not yet proven: no payment record read back on this release | — |
| Seller statements, purchase orders, permission requests | Yes, off-chain | Web and relay from run 37219312021 | Not yet proven (fixtures and harness only) | — |
| Agent Cards (Lithic sandbox, `card_policy`) | Yes | `card_policy` [`H3ae…B93n`](https://explorer.solana.com/address/H3aetJdQXG8EeJSCHZrpQa8iKHBw8e1p9fSPjTUsB93n?cluster=devnet) is executable on Devnet. The production relay's `POST /v1/cards/lithic/asa` answers `invalid_signature`, so the connector is mounted. Other card flags unverified | Not yet proven. On master, activation can report success before the public commitment exists | [#52](https://github.com/stawuah/chainpay-mcp-sdk/pull/52) (merged 2026-10-05): activation is "on" only after the commitment reads back; adds `CARDS_NEW_ACTIVATION_ENABLED` |
| Crossmint checkout | Yes, behind `CHAINPAY_CROSSMINT_ENABLED` / `VITE_CHAINPAY_CROSSMINT` | Unverified (env). The use case says Coming soon | Not yet proven. Crossmint has not accepted a mandate-paid order | [#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55) (merged 2026-10-05): bind the delivery recipient; a refund or failed delivery never reads as delivered |
| Support tips (splitter) | UI, program source and indexer | **No.** The splitter program ID in source has no account on Devnet. `/support` shows Opening soon | Not yet proven | [#56](https://github.com/stawuah/chainpay-mcp-sdk/pull/56) (merged 2026-10-05): Devnet test tokens only, fails closed (stacked on #53) |
| Owner webhooks and email | **No.** The read-only Settings → Notifications tab was removed in `3c3569a` | — | — | [#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57) (merged 2026-10-05): signed `payment.receipt_ready`, off unless `OWNER_WEBHOOKS_ENABLED=true` (stacked on #55). Email is not planned |
| PayPal invoices | Use-case page only (Coming soon). No PayPal code | — | — | [#54](https://github.com/stawuah/chainpay-mcp-sdk/pull/54) (merged 2026-10-05): proposal v2 and site copy, still not implemented |
| Shared pet room | Yes, behind `CHAINPAY_SHARED_PET` / `VITE_CHAINPAY_SHARED_PET` | Off: `/pet` shows the missing-page screen | Not applicable (no payment) | — |

### Policy snapshots: old and new receipts

- **Old receipts** (282 bytes, the original layout) have no payment-time
  snapshot. That is every ChainPay receipt on Devnet today, including the demo
  receipt `7R1i…sh2q`. They can show only today's limits, labeled as today's,
  or a relay read labeled as taken after payment. Nothing is backfilled.
- **New receipts** (371 bytes) store the limits in force at payment. They appear
  only after the program upgrade from #23 is deployed. With #53, a snapshot
  receipt shows only facts the snapshot supports. For example, "Paid before
  expiry" appears only when the stored expiry slot is after the payment slot.
- Fill in the [release manifest](release-manifest.md) for each deploy. It
  records what is deployed and links the evidence for each gate.

## Settlement-path workstreams (2026-09-16 record)

PostgreSQL/Neon was the store at the time. Production now uses Convex; see
"Current state" above.

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
| J6b limits at payment | **Updated 2026-10-05:** in master, not deployed | The program change (#23, `c9f9663`) is in master. The Devnet program was last deployed on 2026-08-15, before it, and no 371-byte snapshot receipt exists. The relay's post-payment read (PR #25) is the only source for new payments until the upgrade. [#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53) makes the captions honest: a relay read is "read after payment", and an old receipt shows today's limits, labeled as today's. See [Policy snapshots](#policy-snapshots-old-and-new-receipts) |
| J6c owner webhooks / email | **Updated 2026-10-05:** not in master | The read-only Settings → Notifications tab was removed in `3c3569a`. Owner webhooks are in pending [#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57) (off unless `OWNER_WEBHOOKS_ENABLED=true`). Email is not planned |
| J7 program asks | **Blocked** | Written asks only — listed below |
| J8 demo evidence | Partial | Readonly baseline USDC receipt PDA `7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q` loads on `/verify`; MCP/SDK control-layer shipped (x402 parsers in SDK, mandate quote on v2, MPP detect, agent skill, acceptance checklist in [acceptance-x402-mcp.md](../guides/acceptance-x402-mcp.md)); live signed MCP 402 → receipt still requires Dre authorization |
| DG1 purchase description | Addressed (off-chain) | Optional seller-signed `description` and `lineItems` in the payment request (PR #25). Shown to the owner, and on `/verify` only from an owner-shared audit link after it verifies against the invoice hash. Never invented; absent when the seller signed none |
| DG2 historical snapshot | Partial (**updated 2026-10-05**) | New receipts carry a snapshot only after the #23 program upgrade is deployed on Devnet; it is in master but not deployed. Earlier receipts are not backfilled and show today's limits |
| PO purchase orders and budget requests | Addressed (off-chain), fixtures only | Signed mandate request links (`chainpay request-mandate` / `request-budget`, demo merchant **Request permission**) open a **PERMISSION REQUEST** card in Requests; **Review permission** prefills the existing builder (budget request: **Requester's agent signs**, `approvedAgent` = the request's agent); the accepted request is stored per permission (`PUT/GET /v1/mandates/{pda}/request`, migration 0011, owner only). Receipts show **Order match** (Matched / Payee differs / No invoice / No order); audit links can carry the order; CSV adds PO number and Order match; the permission panel has a **Statement**. The expected payee is **not enforced on Solana**: Matched is a check, not a guarantee. Harness and unit evidence only; no accepted request exists on Devnet yet |
| DG3 agent name | **Blocked** | Agent shown as address unless the program adds a name |

### Open program asks (Kwasi)

Do not implement until agreed:

1. **DuplicateInvoice**: handled off-chain. The SDK and relay refuse a payment whose receipt already exists with a typed `DuplicateInvoice` before anything is built or sent (PR #25). An on-chain error would need manual account creation in place of Anchor `init`; not planned for this build
2. **PaymentCountExceeded**: merged in #23 (`c9f9663`); the Devnet program upgrade is not deployed
3. **On-chain receipt policy snapshot**: merged in #23 (`c9f9663`); the Devnet program upgrade is not deployed. The J6b relay observation is the fallback until then
4. Optional merchant-signed purchase memo/hash: covered off-chain by the signed request's optional description and line items, bound by the existing invoice hash (PR #25); no program change
5. Optional on-chain delivery attestation field: 32 reserved bytes in the #23 receipt layout; no field yet

Seller-facing copy remains **“Seller attests response served.”** until an approved on-chain field exists.

On 2026-09-15, the hosted landing showed an earlier interface. Production
now runs on Vercel with Convex `notable-bee-447` (origins in
[`scripts/production-release.json`](../../scripts/production-release.json)). Deploys go
through the `Deploy to Vercel` workflow. The deployed revision and the evidence
for each capability are in [Live on Devnet, 2026-10-06](#live-on-devnet-2026-10-06),
[Current state](#current-state-at-master-c936067-2026-10-05)
above and, per release, in the [release manifest](release-manifest.md).
