# Buyer resolution in the isolated PayPal workspace

A delivered output is a merchant work record. A buyer may accept or challenge
that exact revision, with a reason. Acceptance never waives PayPal dispute rights.
The private receipt retains actors, timestamps, reasons, hashes and prior outputs;
the shared receipt redacts those details and exposes only the current review state.

A merchant may approve free rework of a challenged delivered output or a failed
output. Approval archives the old output and creates a new revision. Select
**Run or recover this paid task** to process the original inputs and requirements.
Rework never charges, reserves subscription allowance, consumes it again, or
restores it again. This also holds when a failed output already restored quota.
A random worker attempt identifier prevents late completion from replacing a
new attempt. Acceptance of an earlier revision cannot accept its replacement.

For Orders-funded tasks the merchant can select challenged or failed outputs,
prepare an immutable exact refund proposal, then explicitly approve its amount.
Amounts come from the original purchase amount divided by its original output
count, with checked nonzero exact allocation. No catalog edit or model determines
historical money. Subscription tasks reject this cash refund route.

Approval locks the task and reserves both the selected outputs and exact amount
before network I/O. Confirmed and unknown operations retain reservations. Existing
legacy refunds count once and preserve their failed-output indices before rework.
An ambiguous historical mapping blocks further resolution with an explicit review
error. No automatic mutation retry or replacement refund is available.

Reconciliation reads every known original refund. A verified refund webhook can
recover a lost response using the immutable operation reference (`invoice_id`),
then a provider GET validates the original object. Without that reference or an
already-known refund ID, the task remains under review. Provider refunded capture
statuses are conservatively treated as requiring review because a capture status
alone cannot prove all external refunds are explained. That flag is never silently
cleared; net cost remains unknown. No operator review-clear workflow is provided.

Private routes below require the stored workspace identity. The SDK/MCP expose
read-only resolution history; agents cannot accept, challenge, approve rework or
approve money. Every write uses a stable 16–64 character request ID. Replaying the
same intent is idempotent; changed reuse or stale revision/hash conflicts.

- `POST /tasks/{id}/resolution`: buyer accept/challenge, binding and reason.
- `POST /tasks/{id}/rework`: merchant approval, binding and reason.
- `POST /tasks/{id}/resolution-refunds`: merchant proposal, bindings and reason.
- `POST /tasks/{id}/resolution-refunds/approve`: merchant request ID and digest.

All routes are under `/v1/paypal`. Existing failed-unit refund endpoints remain
for old tasks; once resolution refund proposals exist, use the new ledger route.
Confirmed refund totals and reserved totals are reported separately. Reservations
include confirmed amounts; they are not an additional sum to add to confirmations.

Local database, model, provider and browser fixtures verify these flows. They do
not establish actual PayPal or model-provider acceptance, and no live transaction
or deployment is part of this implementation.
