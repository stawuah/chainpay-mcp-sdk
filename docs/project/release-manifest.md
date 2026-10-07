# Release manifest

A release manifest records one release: what was deployed and where the
evidence for each feature lives. Make one for every production or preview
release you plan to show to anyone. Copy the template below into the release's
PR, issue or tag notes, fill it in, and link it from
[implementation status](implementation-status.md).

**Rules**

- **A passing fixture or health endpoint never substitutes for evidence.**
  Tests, harness screenshots and `healthz` show the code runs. Evidence is a
  real run on this release: a signature, a receipt address, a provider object
  ID, a URL a stranger can open, with timestamps.
- **No secrets.** Record names, IDs, public keys and origins. Never record key
  values, deploy keys, database URLs with credentials, webhook secrets or card
  numbers. Credentials stay in the provider secret stores.
- **Flags record what was read back, not what was intended.** If you cannot
  read a value (Vercel marks it sensitive), write "set, unread" or "unverified".
- **A gate with no evidence link is not passed.** Write "not run" or "failed"
  and leave the feature off or labeled Coming soon.
- **Turn on one optional feature at a time**, each with its own manifest update.
  Roll back with the UI/new-intent flags first. Never create a new payment to get
  out of an uncertain one.
- Writing the manifest does not authorize signing, paying, deploying or
  changing a flag. Each of those needs the owner's explicit approval.

## Template

```markdown
# Release <name>: <YYYY-MM-DD>

Prepared by: <name> · Reviewed by: <name>

## Source
- Repository: stawuah/chainpay-mcp-sdk
- Source SHA (full 40 chars): <sha>
- Release checks run: <link to the green "Release checks" run for this SHA>
- Deploy run: <link to the "Deploy to Vercel" run> · Release ID: gh-<run_id>-<attempt>

## Deployments
| Component | Project / deployment | ID or URL | Deployed SHA | Read back how |
| --- | --- | --- | --- | --- |
| Web (chainpay-web) | prj_Dj8Zwe3XCNYWkBkkMYA8uyaeVumF | <Vercel deployment ID + immutable URL> | <sha> | <deploy log / Vercel meta githubCommitSha> |
| Relay (chainpay-relay) | prj_IkQCAoCokR21UJ6BsfvBoQhnSL0p | <…> | <sha> | <…> |
| MCP (chainpay-mcp) | prj_Dx2WJT5AjTrOxaOe2cj1KMeIBCEc | <…> | <sha> | <…> |
| Convex functions | <deployment name> | <deploy log line> | <sha> | <…> |

## Database identity
- Store: convex | postgres
- Convex deployment name: <e.g. notable-bee-447> (prod/dev) · team/project: <…>
- Release group (scripts/production-release.json `group`): <…>
- Schema/migration level: <Convex schema at SHA / Postgres migrations through 00NN>
- Data origin: <fresh / migrated from …, with the reconciliation record>

## Chain
- Cluster: devnet
- Genesis hash read back: <…>
- ChainPay program: 3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4 · program-data last deploy slot: <…> · upgrade authority: <pubkey>
- Receipt layout produced by that program: 282-byte (no snapshot) | 371-byte (snapshot)
- card_policy program: <id, or "not used">
- Support splitter program / vault / vault USDC account: <ids, or "not deployed">
- Mints accepted for this release: <mint addresses>

## Public origins
- Web: <…> · Relay: <…> · MCP: <…> · Convex site: <…>
- Matches scripts/production-release.json: yes/no

## Flags (value read back, or "set, unread" / "unset")
| Flag | Where | Value |
| --- | --- | --- |
| CHAINPAY_CROSSMINT_ENABLED | relay, MCP | |
| VITE_CHAINPAY_CROSSMINT | web build | |
| CARDS_CONNECTOR_ENABLED | relay | |
| CARDS_ISSUER_WRITES_ENABLED | relay | |
| CARDS_CHECKOUT_ENABLED | relay | |
| CARDS_NEW_ACTIVATION_ENABLED (#52) | relay | |
| LITHIC_API_URL (must be sandbox) | relay | |
| CARDS_PARTNER_TOKEN_ACCOUNT / VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT | relay / web | |
| VITE_CHAINPAY_CARD_POLICY_PROGRAM_ID, VITE_CHAINPAY_CARD_ISSUER_ENV | web build | |
| SUPPORT_LIVE, SUPPORT_CLUSTER, SUPPORT_PROGRAM_ID, SUPPORT_VAULT, SUPPORT_VAULT_USDC | Convex | |
| VITE_SUPPORT_LIVE, VITE_SUPPORT_CLUSTER, VITE_SUPPORT_PROGRAM_ID, VITE_SUPPORT_TRACKER_URL, VITE_SUPPORT_RECIPIENT_A/B (#56) | web build | |
| OWNER_WEBHOOKS_ENABLED (#57), OWNER_WEBHOOKS_SECRET_KID | relay | |
| OWNER_WEBHOOKS_DISPATCH_URL (#57) | GitHub repo variable | |
| CHAINPAY_X402_ALLOWED_ORIGINS, CHAINPAY_X402_RECEIPT_MERCHANTS | relay, MCP | MCP Production set 2026-10-07 to `https://chainpay-demo-merchant.vercel.app`; Preview not set |
| CHAINPAY_SHARED_PET / VITE_CHAINPAY_SHARED_PET | relay + Convex / web | |
| Managed signing provider (healthz `managed_signing`) | relay | |

## Scheduled jobs
| Job | Schedule | Target URL | Last successful run (link) |
| --- | --- | --- | --- |
| Cards reconcile | | | |
| Support indexer (Convex cron) | | | |
| Owner webhooks dispatch (#57) | | | |

## Evidence per gate
| Gate | Result | Evidence links | Notes |
| --- | --- | --- | --- |
| Receipt render | | | |
| Core payment | | | |
| Custom x402 | | | |
| Cards | | | |
| Support rehearsal | | | |
| Crossmint | | | |
| Owner webhooks | | | |

## Rollback
- Previous release manifest: <link>
- Flags to flip first: <…>
- In-flight payments / refunds / activations at release time: <count + where they are tracked>
```

## Acceptance gates

These come from the 2026-10-05 audit remediation plan. Check a box only when
the evidence column of the manifest links the proof.

Boxes ticked on 2026-10-06 point at [Devnet live runs, 2026-10-06](#devnet-live-runs-2026-10-06).
Those runs used **preview** deploys and preview Convex, not a production
release, so a ticked box here proves the code path on Devnet. It does not mean
the feature is switched on in production. Where one gate held two checks and
only one was proven, it is split in two so the unproven half stays unticked.

### Receipt render (audit fixes A1–A3, A5, A6, A8, A10; [#53](https://github.com/stawuah/chainpay-mcp-sdk/pull/53))

- [ ] Without a wallet, the public site opens `/verify/<demo receipt>` from the landing **See a receipt** and shows the receipt card. Exact amount and token match the chain.
- [ ] An old receipt with no payment-time snapshot never says the payment was within the limit or paid before expiry. Current limits are labeled as current.
- [ ] A snapshot receipt (371 bytes, only after the program upgrade) shows only facts the snapshot supports. "Paid before expiry" appears only when the stored expiry slot is after the payment slot.
- [ ] The illustrative sample receipt never implies a live verification.
- [ ] A raw address and a full `/verify/<pda>` link resolve to the same card. Malformed links fail with a clear error. The pasted origin is never fetched.
- [ ] Retrying receipt A and then opening receipt B: the late A result never replaces B or its amount.
- [ ] `/verify/card` with no link offers a paste field. An RPC error offers a retry. Mismatch, superseded and wrong-card results never say the values match.
- [ ] Embed overview: a load error restores the address field and a retry. Unsettled operations never appear as spending.

### Core payment ([implementation status](implementation-status.md), [acceptance runbook](local-e2e-testing.md))

Use one controlled owner and one reviewed Devnet mint. Human approval comes
first. Delegated Privy signing needs its own proof.

- [ ] Approve limits, request a permitted amount, sign, wait for finality. The receipt verifies in the owner UI and in a public browser.
- [ ] Over-limit, paused, revoked and duplicate requests are refused with no extra transfer.
- [ ] An ambiguous operation is recovered under the original approval, without a second payment.
- [ ] The payment record reads back from the release's database (store identity above).
- [ ] Recorded: release ID, timestamps, exact amounts (base units and decimals), signatures, receipt addresses.

### Custom x402 ([x402 acceptance checklist](../guides/acceptance-x402-mcp.md))

- [x] 402 challenge → mandate payment → finalized receipt proof → HTTP 200 resource. [2026-10-06](#devnet-live-runs-2026-10-06): the run used a standard v2 challenge on the receipt-merchant path.
- [x] A replay of the same request does not pay twice. [2026-10-06](#devnet-live-runs-2026-10-06)
- [ ] An unavailable merchant after settlement keeps the original receipt and does not pay again. Not run.
- [ ] Standard v2-shaped challenges settle only for origins in `CHAINPAY_X402_RECEIPT_MERCHANTS`. Generic facilitator or sponsor compatibility is not claimed. Partial: with `settleIfReceiptMerchant: false` the same origin came back `x402_unsupported_sponsor`; an origin outside the list was not tried.

### Cards ([#52](https://github.com/stawuah/chainpay-mcp-sdk/pull/52))

- [x] Activation reports "on" only when the issuer shows the card open, the limits are mirrored, and the public `CardCommitment` reads back for that policy version. [2026-10-06](#devnet-live-runs-2026-10-06)
- [ ] Partial states (proof pending, limits not copied, issuer pending) show what actually happened. "Paused" appears only when the issuer reads back paused. Partial: freeze showed `pending_issuer_confirmation` and turned Paused only after Lithic read back PAUSED; proof-pending and limits-not-copied were not seen live.
- [ ] Period end, close and discharge keep their checkpoint state, and reconcile repairs it. Cite the scheduled reconcile run that reached this deployment. Partial: close checkpoints confirmed and all three statements discharged after a manual reconcile call; the scheduled `Cards reconcile` workflow is skipped (no `CARDS_RECONCILE_URL` / `CARDS_CRON_SECRET`).
- [x] With `CARDS_NEW_ACTIVATION_ENABLED=false`, direct API calls to prepare and activate are refused. Reads, pause, statements and repayment still work. [2026-10-06](#devnet-live-runs-2026-10-06)
- [x] Transparent repayment produces a ChainPay receipt. Private repayment keeps its authorizer-attested label. Simulated credit is labeled simulated. [2026-10-06](#devnet-live-runs-2026-10-06) (after the `card_policy` upgrade; SDK side in open #63)

### Support rehearsal ([#56](https://github.com/stawuah/chainpay-mcp-sdk/pull/56), `programs/support-splitter/DEPLOY.md`)

Devnet test tokens only. No mainnet deploy, no authority removal, no swaps.

- [ ] Both partners' Devnet recipient addresses were set up through the signed process and verified.
- [ ] The splitter build identity and the authorized Devnet deployment are recorded. Dual-signature initialization signature is recorded.
- [ ] Rehearsed: contribution → finalized index → allocate → each recipient claims their own share. Exact amounts and rounding checked.
- [ ] Duplicate signature indexing, repeat payout, wrong-destination refusal, and one side failing without blocking the other were all tested.
- [ ] On-chain balances and indexer readback match. Network labels say Devnet. Mobile flow checked.
- [ ] The page opened only after program, tracker and UI agreed.

### Crossmint ([#55](https://github.com/stawuah/chainpay-mcp-sdk/pull/55))

- [ ] Staging project, Orders API permissions and the server-only auth secret are confirmed by name only.
- [x] One operator-created staging order is quoted. The sanitized order shows chain, mint, payment recipient, delivery recipient, payer, exact amount and expiry. [2026-10-06](#devnet-live-runs-2026-10-06)
- [x] Crossmint credits that order when it is paid by the mandate-controlled transfer. No plain-transfer fallback, no agent-funded wallet. [2026-10-06](#devnet-live-runs-2026-10-06). **Caveat:** the order stayed `awaiting-payment` for ~5 minutes and was credited 13 s after a manual `POST /orders/{id}/payment {"type":"crypto-tx-id"}`. #61 makes the relay send that call itself; a re-run on a preview built after #61 has not happened yet.
- [ ] The finalized ChainPay receipt matches Crossmint's payment state. Delivery state is tracked separately. A refund or failed delivery stays visible.
- [ ] Refresh, quote expiry, payer mismatch, amount mismatch, replay and ambiguous responses resume the original operation. None buys again.
- [ ] Only after all of the above: `CHAINPAY_CROSSMINT_ENABLED` and `VITE_CHAINPAY_CROSSMINT` are on for this environment, and the Coming soon copy is updated.

### Owner webhooks ([#57](https://github.com/stawuah/chainpay-mcp-sdk/pull/57))

- [x] One deployed Devnet `payment.receipt_ready` event reaches a controlled HTTPS endpoint and verifies with the documented signature check. [2026-10-06](#devnet-live-runs-2026-10-06) (preview relay)
- [x] Endpoint answers 2xx, 500, 429, and a timeout after storing the event. Retries reuse the event ID. [2026-10-06](#devnet-live-runs-2026-10-06)
- [ ] A dedupe-by-ID receiver processes it once. Not run: the test receiver logged every attempt (all with the same `webhook-id`) and did no dedupe.
- [ ] A dispatcher crash or restart loses no event. Not run.
- [x] Concurrent dispatchers never deliver the same row twice. [2026-10-06](#devnet-live-runs-2026-10-06): two concurrent dispatch calls, one claimed 0 and the other 1.
- [x] An invalid signature is rejected. Another owner's endpoints are not reachable. Unsafe destinations are blocked. [2026-10-06](#devnet-live-runs-2026-10-06)
- [ ] A stale timestamp is rejected. Not run (a receiver-side check).
- [x] A receiver outage does not delay settlement or create a new payment. [2026-10-06](#devnet-live-runs-2026-10-06)
- [ ] Cite the scheduled dispatch run that reached this deployment.

## Baseline: master `c936067` (partial, 2026-10-05)

This was filled from read-only public checks. It is not a complete manifest:
deploy-account details and every evidence gate are still open.

- Source SHA: `c936067af6c8c34d33c65a06f5f0119a405178f6`.
- Deploy run: [37219312021](https://github.com/stawuah/chainpay-mcp-sdk/actions/runs/37219312021) (2026-10-04, `workflow_dispatch`, all jobs succeeded) · release ID `gh-37219312021-1`.
- Vercel deployments from that run (inspect IDs): web `8eSWcRK4aivDKbT8t9mYp1zhJK7n`, relay `FqdsSrf8QuqeDZug8zYnEg9sxc9y`, MCP `8uLjQwUDuUgmHXuiyukxbnxMGTVN`. Whether these still serve the aliases is unverified.
- Database: Convex production `notable-bee-447`, group `chainpay-production-v1`.
- Chain: Devnet. ChainPay program `3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4`, program data last deployed at slot `484104138` (2026-08-15). It writes 282-byte receipts: 26 exist, and 0 of 371 bytes. `card_policy` `H3aetJdQXG8EeJSCHZrpQa8iKHBw8e1p9fSPjTUsB93n` is deployed. The support splitter is not deployed.
- Public origins: as in [`scripts/production-release.json`](../../scripts/production-release.json).
- Flags: unread. Two values were observed from outside: the cards connector answers on the relay, and `/pet` is off.
- Evidence gates: none passed on this release yet.

## Devnet live runs, 2026-10-06

Not a production release. Every run used Devnet, preview deploys of the relay
and MCP built from upstream master `dffa44a` (#60), preview Convex
`acrobatic-mole-703`, the Lithic **sandbox** and Crossmint **staging**.
Production env was not changed. Raw run logs stay with the operator; the IDs
below are enough to check each step on-chain or with the provider.

### Agent cards (Lithic sandbox, MagicBlock Devnet TEE)

- Preview relay `https://chainpay-relay-cards-e2e.vercel.app` with deploy-time `CARDS_CHECKOUT_ENABLED=true`.
  Gate-off check on `https://chainpay-relay-i1nq9kih7-chainpay.vercel.app` (`CARDS_NEW_ACTIVATION_ENABLED=false`).
- Card program `H3aetJdQXG8EeJSCHZrpQa8iKHBw8e1p9fSPjTUsB93n`. ChainPay program `3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4` (282-byte receipts).
- TEE attestation (`/v1/cards/tee/attestation`, production and preview): `mode: enforce`, Intel DCAP chain verified (TCB UpToDate), measurements match.

| Check | Result | Evidence |
| --- | --- | --- |
| Base setup (owner-signed) | init_card, delegate_card, escrow top-up | [`4jF26WMh…`](https://explorer.solana.com/tx/4jF26WMh6Stwf6cqyb7bPcEZ7QawtMMPaZ1QVXi1ZcnfBdfAtfErsXPzpSySgWdfsitxtDQBnWeTTUCHmtY8Yxpx?cluster=devnet), [`3eGhJfDm…`](https://explorer.solana.com/tx/3eGhJfDmqwkDaVW2D2zKeYWKb8DwTQFF6aCSx1ncynFh6HsK2b5e5ktJdwYm6XHbs48sPi4CfsjyK8tytVHiv6TJ?cluster=devnet), [`61363kGJ…`](https://explorer.solana.com/tx/61363kGJN8QWwAnyshcqqEESLfFR921hJH2UtFvBRQpnesPvq9uisKiB3G2iRdbgFYKLxjxSPC8cgmxe1wiznY9h?cluster=devnet) |
| Activation | `activation.state: active` at 13:14:33Z. `commitment.confirmedAt` 13:14:31Z comes before issuer OPEN | `CardCommitment` [`DAHX…SZXX`](https://explorer.solana.com/address/DAHXQq6MA5MNz2KWRSEEfdoAh1RNFMuJwURwaLt2SZXX?cluster=devnet) read at finalized: seq 1, policyVersion 1, slot 508104508 |
| $20 purchase | **Approved** | Lithic AUTHORIZATION `e73796bf-a7bd-4404-87f9-1d212f347f2d` |
| $40 purchase | Agent path refused (409, PER `BudgetExceeded`), no issuer call. At the network with no intent: **declined** | Lithic AUTHORIZATION `d5f273de-c248-4911-80dc-b4f017d21490` (UNAUTHORIZED_MERCHANT) |
| Freeze | `pending_issuer_confirmation` → `confirmed` only after Lithic read PAUSED. A redeem opened just before was declined `CARD_PAUSED` | Lithic txn `6c4c63b0-8fb6-480e-bf6e-74c641078c38` |
| Privacy | Policy visible to the owner, `not_visible` to a fresh stranger key | — |
| New activation off | prepare / activate → 503 `new_activation_disabled`; list, card, statements, freeze, repayment, reconcile → 200 | gate-off preview above |
| Transparent repayment (statement C, $1.00) | `repay_statement` → ChainPay `execute_payment`, receipt verified at finalized, discharged on PER at 14:39:53Z | tx [`2xjwgS6X…`](https://explorer.solana.com/tx/2xjwgS6XAS59255knTXpDzHSovdc5gVGnpnW2fK9nmGVodrvke5rLm2FGqnQvcS72MmA2s8z44Ub7tpbQCFLvQs3?cluster=devnet), receipt [`5gFw…7pP7`](https://explorer.solana.com/address/5gFweJeBTjuR3kkqWSegXWSPEWiHkTJp3diKF9Za7pP7?cluster=devnet) (282 bytes). Statement A's earlier receipt [`4Tq3…AKTT`](https://explorer.solana.com/address/4Tq3gpiYjcPuSWfXJjXcv72s8gAmWyqJB7a53TL4AKTT?cluster=devnet) discharged on the first reconcile |
| Private repayment (statement B, $0.40) | MagicBlock deposit + settlement, verified `magicblock_queue_settlement`, `payerVerified: false`, "Simulated credit", discharged at 14:35:23Z | deposit [`3YyV8ndz…`](https://explorer.solana.com/tx/3YyV8ndzAigTFDs1pvHQ6sqG1CrQBs7QDxZDdvc7CrZ6ttBTu3dXGDbZhxuhKTTTkta17NsiWc5z1jPiuVgNuwWG?cluster=devnet), settlement [`3L7HAjDm…`](https://explorer.solana.com/tx/3L7HAjDmGNjtZWN5KNCGgzQKi9theqqEn9VekPtsEtq6jqFHKQctqqBideAgk8zpMLUwWKT13XgkKApUVDDvhrgz?cluster=devnet) |
| Outstanding balance | 542¢ at start → **0¢** at the end | PER `statementOutstandingCents`, read as the owner |

Repayment needed the `card_policy` upgrade deployed at Devnet slot 508123988
(282-byte receipt decode and rent) and the SDK change for MagicBlock deposit
tag 24, both from open #63. Open items: one later $1.00 purchase was declined
`SUSPECTED_FRAUD` after the ~2 s ASA deadline although PER authorized it, and
its activity row reads "reversal" (display only). Production still declines
every card purchase until `CARDS_CHECKOUT_ENABLED` and
`CARDS_CHECKOUT_RUNNER_SECRET` are set.

### Standard x402 v2 (receipt-merchant path)

- Preview relay `https://chainpay-relay-eoddc6irq-chainpay.vercel.app`, preview MCP `https://chainpay-3zj4mcb8c-chainpay.vercel.app` with `CHAINPAY_X402_ALLOWED_ORIGINS` = `CHAINPAY_X402_RECEIPT_MERCHANTS` = `https://chainpay-demo-merchant.vercel.app`.
- Demo merchant `https://chainpay-demo-merchant.vercel.app/data`, `CHAINPAY_X402_CHALLENGE_SHAPE=v2`, price 0.1 Devnet USDC (`100000`, 6 decimals).

| Step | Result | Evidence |
| --- | --- | --- |
| `GET /data` | 402, `x402Version: 2` | — |
| `execute_x402_payment` (human signing) | classified standard v2, preflight valid, agent signs, relay `submitted` | payment `payment_ab9107d4…` |
| Settlement | finalized, slot 508110881 | tx [`2nGaP5WS…`](https://explorer.solana.com/tx/2nGaP5WSqtgkVutuoJXiNXkR9wPvDFARt24LrtNoWdhVJ8peDFtB3QooRtqi574Mk7cfZehRtmqZrMkhZfdXLRDQ?cluster=devnet) |
| Resume by paymentId | `x402_verified`, merchant answered **200** with the receipt proof | receipt [`Fqn1…ZtZV`](https://explorer.solana.com/address/Fqn1y5q7dGvtFM49xGpZXFfsmdtRpm9ENPDtZHBnZtZV?cluster=devnet) |
| Replays (same signed tx, fresh request, resume, direct merchant call) | `duplicate_invoice` or the same receipt and 200; `get_mandate` paymentCount 1; balances unchanged | exactly 0.1 Devnet USDC moved, once |

Open in #64: the owner's x402 job list labels this paid job `unknown` /
`x402_unsupported_sponsor`, and the demo merchant can default `payTo` to the agent.

### Owner webhooks

Preview relay as above, with deploy-time `OWNER_WEBHOOKS_ENABLED=true`. Dispatch
called the way `owner-webhooks-dispatch.yml` does (bearer `CRON_SECRET`; 401 without it).

| Check | Result |
| --- | --- |
| Event | `payment.receipt_ready` `evt_0425bf41af2fd7e9dbc9390db52a38ad` for the x402 receipt above, written at confirmation (13:40:09Z) while the receiver answered 500 |
| Retries | 500 → retry 60 s → 200 delivered; manual redeliver → 429 → retry; 15 s hang → timeout → retry 300 s → 200 delivered. 5 attempts, same `webhook-id`, identical body bytes |
| Signature | All 5 verified (Standard Webhooks HMAC-SHA256); wrong key and tampered body rejected |
| Concurrency | Two dispatchers at once: one claimed 0, the other 1 |
| Isolation | Another owner: 404 on deliveries and redeliver, empty list; agent token: 403; `http://`, loopback, link-local, private and credentialed URLs refused 400 |

Not run: a scheduled GitHub dispatch run (no repo var/secret yet), a dispatcher crash mid-run, a stale-timestamp receiver.

### Crossmint (staging)

| Field | Value |
| --- | --- |
| Order | `5a5fe611-e678-4312-8ac1-25e219292127`, quoted 0.1203 USDC (`120300`), expiry 13:16:23Z, payer and recipient = owner |
| Prepare | `prepare_crossmint_payment`: quote match, 19 preflight checks pass |
| Payment | mandate CPI transfer + Crossmint memo, finalized: [`AsCF3JLh…`](https://explorer.solana.com/tx/AsCF3JLhHxtuYNiu82KqJW8epaKWiF7sWmYujLfsMgbsqyxkiutGmr6Ag7YmsSxoeZHEFymko6fJ4T1MvMpWaEx?cluster=devnet), receipt [`3eU8…9FZw`](https://explorer.solana.com/address/3eU8zvhpEaTYm3sChj7yJuyeSCTyJoUVwVuypEYy9FZw?cluster=devnet). Owner USDC −0.120300 exactly |
| Credited | `payment.status: completed`, `received.txId` = that signature, **only after** a manual `crypto-tx-id` call (13:11:23Z) |
| Replay / expiry | Re-running, resuming and re-preparing (before and after quote expiry) returned the original operation or refused; no second payment |
| Delivery | `in-progress` for 18 minutes, nothing arrived. Paid, not delivered |

The flags stay off. Next: one Devnet re-run on a preview built after #61, which
sends the `crypto-tx-id` call from the relay, before
`CHAINPAY_CROSSMINT_ENABLED` / `VITE_CHAINPAY_CROSSMINT` go on.
