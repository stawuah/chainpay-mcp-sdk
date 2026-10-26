# PayPal sandbox service subscriptions

This isolated service supports a merchant-owned **$40.00 USD monthly subscription
for ten service units**. It is prepaid service access, not escrow or an on-chain
mandate. Comparison costs two units per output; summary/check cost one. No
rollover or overage, and no automatic replacement charge.

## Explicit operator setup

Leave `CHAINPAY_PAYPAL_SUBSCRIPTIONS=false` until sandbox acceptance. An operator
must create a sandbox catalog product and plan in PayPal and set
`CHAINPAY_PAYPAL_SUBSCRIPTION_PLAN`. Automatic catalog provisioning is not
implemented. The backend reads the actual plan before purchase and during
reconciliation: exactly one REGULAR MONTH/1 unlimited cycle, USD40.00 fixed price,
no trial/setup fee/taxes or quantity pricing, and `auto_bill_outstanding=false`.
`CHAINPAY_PAYPAL_NEW_PURCHASES` must also be true for new purchases/allocations.
These flags do not remove scoped reads, cancellation, or paid work recovery.
No shared database migrations or deployments are part of setup verification.

## Buyer and agent flow

Open the separate PayPal workspace with a buyer access grant. The subscription
panel presents exact terms, persists a local creation identity before dispatch,
and exposes the strictly validated PayPal sandbox approval link. Approve there,
then reconcile the original subscription. ACTIVE alone provides no allowance.
Unknown creates remain the original operation; verified subscription webhooks
can recover the provider identity only after matching its local custom ID/plan.

Service periods are **ChainPay service policy**, anchored to an observed start
and calendar-month schedule, not PayPal-certified historical coverage. January
31 anchors February's last day and March 31. Record the schedule before grants.
Exactly one COMPLETED USD40 payment within one hour after a recorded period start
must uniquely match an unpaid period. Late/catch-up/aggregate payments, missing or
contradictory schedules, and incomplete transaction history require merchant
review with no automatic grant. History reads use fixed provider routes and
bounded 30-day windows (at most 120 windows and 1,200 response records per reconciliation); pagination, incomplete counts or traversal/record cutoffs block grants. All windows must complete before any new grant becomes usable; normalized immutable payment proofs reject contrary replay. Replaying the
same payment never grants again. Late reconciliation does not extend expiry.

Choose an existing quote and explicitly approve its unit allocation. Alternatively,
approve a distinct agent identity, selected service, per-task and per-period unit
limits and expiry. Agents can use `paypal_get_allowance` and
`paypal_consume_allowance` with the original task and delegation IDs, then run the
paid task. No SDK/MCP subscription, cancellation, refund or limit-increase tools
exist. Agent allowance reads omit payer details, raw observations and approval
secrets. Buyer ownership comes from the stored verified delegation, not request
JSON; buyer and assigned agent can inspect the task.

Allocation shares the task row lock with Orders checkout, then locks the period
and delegation. A quote can use only one funding method. Failed outputs restore
units once; unknown work remains reserved. **Lifetime delegation reservations
never reset on failure**, preventing repeated failed work from bypassing ceilings.
Revocation/expiry stops new allocations; already reserved work may finish or
recover after cancellation, period expiry or a feature pause. Verified payment
refund/reversal or review blocks further processing.

Cancel explicitly with “stop renewal; keep verified paid access.” Cancellation
operations are persisted before dispatch; an unknown result is read/reconciled,
never blindly replayed. Allowance restoration is not a cash refund. The panel
exposes verified SALE payment references for merchant billing review. No SALE
cash-refund adapter/UI is implemented, and SALE IDs must never reach the v2
capture-refund route.

## Evidence and release gates

Run isolated local fixtures with `PAYPAL_TEST_DATABASE_URL` and
`cargo test -p chainpay-backend --features paypal paypal:: -- --include-ignored`.
Provider/model calls in fixtures stay local. Passing fixtures do not establish
real sandbox compatibility. Release requires operator-created plan acceptance,
buyer approval plus actual recurring-payment/schedule/transaction evidence,
verified completed/refunded/reversed webhooks, empty-204 cancellation and unknown
result reconciliation. Merchant SALE refund execution remains external billing
review; adding an adapter requires explicit sandbox verification of the deprecated
v1 Payments contracts. No real credentials, financial actions, deployment or
production readiness are implied by implementation.

## Resolving a billing review

The merchant opens the read-only subscription panel and records the original local
subscription ID, PayPal subscription ID from the merchant sandbox dashboard,
SALE payment reference, exact currency/amount/time, service-period observations,
and the review reason in a dated support/audit record. Compare these to the
original PayPal sandbox transaction history and keep the evidence and decision
with that record. Do not retry a charge or treat a missing response as failure.

This implementation has no review-clear or historical-period mapping override.
An incomplete/ambiguous record stays blocked: it cannot be automatically mapped,
unblocked, or used to generate replacement allowance. Where appropriate, the
merchant resolves the original billing in the PayPal sandbox dashboard, stopping
renewal and/or refunding the original SALE there under the merchant's existing
approval procedure. Confirm the provider result and record its reference; an
unknown cancellation/refund remains unresolved. Never pass a SALE reference to
ChainPay's v2 capture-refund endpoint.

Only after the original billing issue is resolved and cancellation is confirmed
may the buyer explicitly approve a separate replacement subscription at the
stated terms. That creates a new purchase identity; it is not recovery of the old
operation or an automatic transfer of blocked allowance. Keep both records and
their relationship in the audit record. Software implementation does not grant
financial-action approval, and no new financial override authority is introduced.
