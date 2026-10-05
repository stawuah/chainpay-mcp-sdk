# PayPal invoices: proposal v2

**Status: proposal only. Not implemented.** No PayPal code, credentials, routes or
tools exist in this branch, and nothing here is enabled. This page is for whoever
implements the flow later. The partner briefing is the
[18-slide PDF](../assets/paypal-briefing-v2.pdf) (5 October 2026).

V2 replaces the October 3 idea, where tokens went straight to the merchant and
PayPal only recorded an external payment. That earlier "no money goes through
PayPal" framing no longer applies.

## The flow: two separate payments

1. **Token leg (Solana Devnet).** The buyer pays exact Devnet test tokens to the
   **ChainPay treasury** through their existing spending permission. The relay
   creates the normal receipt PDA. The receipt proves the treasury received the
   tokens. Nothing more.
2. **Payout leg (PayPal sandbox).** Axum sends one payout to the merchant from
   **ChainPay's own prefunded PayPal sandbox balance**. Tokens are not converted,
   redeemed or pegged to PayPal funds. The two amounts are shown separately under
   signed demo terms.
3. **Bookkeeping.** The merchant compares the invoice, the Solana receipt and the
   successful payout item. After the merchant approves, Axum records the payment as
   `OTHER` on the invoice and reads it back.

The site shows three proof rows: Solana receipt, PayPal payout item, invoice
marked paid.

The nine-step sequence is:

1. Merchant approves the invoice draft. Verify the invoice-owning merchant account.
2. The authorized merchant account creates and sends the sandbox invoice. Store its ID and revision.
3. Merchant signs a versioned binding. It covers environment, invoice ID and revision, buyer, treasury destination, payout recipient, exact fiat and token terms (mint, program, decimals, base units), fees, expiry and refund terms. The `request_hash` is a digest of that **complete binding**, not a bare invoice ID.
4. Buyer approves the exact terms. Run preflight (invoice still unpaid, recipient enrolled, prefunding headroom). **Reserve the invoice intent before the token debit.**
5. The existing mandate transfer pays the treasury and creates the receipt. "No new Anchor instruction" is a target that still needs a compatibility check.
6. Verify the finalized receipt (cluster, program, PDA, binding hash, owner, mint, base units, treasury recipient). Attach a durable unique receipt claim to the reserved invoice intent.
7. Axum re-reads the invoice and dispatches **one** single-item payout. Its identifiers come from the claimed operation.
8. Merchant compares and signs the bookkeeping approval.
9. Record `OTHER` with an explicit amount. Read back exactly one matching entry, expected `MARKED_AS_PAID`.

## Treasury trust boundary

The mandate enforces only the token leg. **Solana does not enforce the PayPal
movement or any refund.** ChainPay's backend and treasury controls enforce those.
That adds three responsibilities: holding test tokens in the treasury, keeping a
prefunded sandbox balance with its own ledger, and compensation.

- Axum owns policy, PayPal credentials and recovery. The existing Convex persistence stays. No second backend.
- Agents get read-only invoice and receipt tools. No payout, refund or `pay_order` tool is exposed.
- Treasury signer access is isolated from agent tools.

## Completion rule: matching payout item SUCCESS

Only the **matching payout item** in state `SUCCESS` proves that the merchant was
credited. HTTP 201 does not prove it. Batch `SUCCESS` does not prove it either:
PayPal's own example shows a successful batch that contains failed or unclaimed
items.

| Observed state | Allowed | Forbidden |
| --- | --- | --- |
| Item `SUCCESS` | Reconcile the invoice and keep the payout evidence | Treating a later bookkeeping failure as a payout failure |
| Item `FAILED` | Persist the no-payment proof and evaluate compensation | Refunding on a timeout or an unverified event |
| Item `RETURNED` | Verify the return against the original payout, then evaluate compensation | Refunding just because cancellation was requested |
| `PENDING`, `UNCLAIMED`, `ONHOLD`, `BLOCKED`, unknown | Read current state, poll within limits, then manual review | A second payout or a refund |
| Later `REFUNDED`, reversal, outside invoice payment | A separate exception review | Automatic compensation |

Idempotency: PayPal deduplicates `sender_batch_id` for 30 days. Keep permanent
local unique claims on the invoice and the receipt. Persist the intent, payload,
claims and sender IDs **before** the POST. On an unknown response, reconcile the
original operation. Never mint a fresh key to try again.

Webhooks only prompt reconciliation. Verify each signature and deduplicate event
IDs, then read the current item state. A periodic job and a manual "check status"
action cover missed events. Neither one is a new payout command.

## Refund and compensation

- A refund is a **separate treasury-signed transfer**. It goes to the original buyer only, in the original mint and token program, for exactly the original base units. It happens **at most once** per original receipt.
- It is allowed only after terminal no-payment proof or verified returned funds.
- **The original receipt stays.** The mandate's `amount_spent` and transaction count stay consumed. Further spending needs remaining authority or new owner approval. The UI keeps both the payment and the refund.
- Stop any payout worker before refunding. Persist the signed transaction and signature **before** broadcast. A timeout becomes `refund_unknown`. Do not build a replacement until history proves the original did not land and it can no longer land.

## Waiting is the default

Unknown, pending, unclaimed, held and ambiguous outcomes **wait**. They never
release a second payout or a refund. A bookkeeping failure after payout success
**never** triggers another payout or a token refund. Recovery stays read-only.

This proposal does **not** claim exactly-once settlement across PayPal and
Solana. The two systems share no atomic transaction. It is an operational
compensation workflow.

## Open gates and partner decisions

Preflight is advisory. Balance data can lag up to three hours, a recipient can
become blocked, and the hosted invoice checkout can be paid while the payout is in
flight.

Partner decisions:

1. Accept temporary test-token custody in a ChainPay treasury for the sandbox, and decide who controls the treasury key.
2. Decide whether ChainPay holds a prefunded PayPal sandbox business balance as the payout sender.
3. Map the accounts: the merchant invoice owner, the ChainPay payout sender and the merchant payout recipient. A display name or email is not proof of authority.
4. Agree the exact demo terms: one USD invoice, one Devnet token, full payment only, plus explicit token amount, fiat amount and fee allocation.
5. Agree how the demo handles an outside invoice payment race: controlled accounts plus detection, routed to review.
6. Verify the deployment identity and existing-data continuity.

Sandbox gates, before any "works" claim:

1. A provider contract spike: invoice create, send and read; single-item payout success and failure; recovery from an unknown response; `OTHER` record and readback; webhook verification. Keep sanitized responses.
2. Durable policy: the immutable binding, claims, dispatch outbox, item reconciliation and refund persistence, with writes disabled by default.
3. Three evidenced runs: a success, a terminal failure that refunds once, and an unresolved outcome that waits. Replayed and concurrent requests cause no extra money movement. Any simulated provider failure is labeled as simulated.

Re-estimate after the spike. The October 3 estimate did not include treasury
payouts or compensation.

## Not implemented

None of this exists in code. There is no PayPal connector, payout worker,
treasury refund signer, webhook endpoint or invoice tool. The `/use-cases/paypal-invoices`
page is labeled "Coming soon". Production PayPal, real funds and any token-to-fiat
conversion are out of scope.
