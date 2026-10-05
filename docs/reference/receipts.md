# Receipts and seller evidence

A receipt makes a settled ChainPay payment inspectable. Payment evidence and
seller delivery evidence are separate; the UI must show which was verified.

## Read a receipt

Open a receipt from payment history, owner deep link `/app/receipts/<receipt-address>`
when signed in, or visit `/verify/<receipt-address>` on a deployment running this
fork. `/verify` accepts a pasted receipt address or a full `/verify/<receipt-address>`
link from any site; the link is parsed in the browser and its site is never
contacted. A malformed address or a link that isn't a receipt link gets a plain
error. The public verification page needs no connected wallet. Landing
**See a receipt** opens a real Devnet receipt (`7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q`,
an original receipt without a snapshot), fixed in `frontend/src/receipts/demoReceipt.ts`. The
[SDK guide](../guides/use-the-sdk.md) links to the same receipt reader.

Payment success in the dashboard renders the same **ReceiptCard** component as
public verify — not Explorer-only confirmation.

The reader checks the account's program ownership, account type, address
derivation, and settled status. The public page uses finalized chain reads; SDK callers must explicitly select
that commitment when they need the same finality. A missing,
unreadable, or invalid account is not a successful receipt.

## What the payment record means

| Field or state | Meaning |
| --- | --- |
| Amount and mint | The exact transfer in token base units; display decimals come from verified mint data |
| Source and recipient | Token accounts used for that transfer, not automatically merchant identities |
| Mandate and agent | The permission and approved signer recorded in the receipt |
| Execution slot | Solana's recorded slot; do not invent an exact wall-clock time if unavailable |
| Transaction signature | Verified transaction evidence when recoverable; `signature_reference` is not itself the transaction signature |

If mint metadata cannot be verified, show base units instead of assuming six
decimals. If transaction history is unavailable, explain that limit without
manufacturing a signature or downgrading a valid settled receipt.

The public reader also reads the mandate's **current** state. A mandate can
change or be revoked after payment, so current limits are only ever shown as
today's limits, never as the limits at payment.

## Limits at payment

Receipts written after the policy-snapshot program upgrade are 371 bytes
instead of 282. Every original field keeps its offset; the extra bytes hold the
mandate's limits immediately after the payment (per-payment limit, total limit,
amount spent, payment count, payment-count cap, expiry slot, cooldown). Readers
accept both sizes, and `decodePaymentReceipt` returns `policySnapshot: null` for
an original receipt.

Each limits display names its source:

| Source | Meaning |
| --- | --- |
| `on-chain` | Written by the program into the receipt account at payment |
| `relay-observed` | Read from the mandate by the ChainPay relay after the receipt finalized, at or after the payment slot. Not stored on Solana. If the mandate had already paid again, the spent amount is left out |
| `not-recorded` | Neither exists; any limits shown are today's |

On-chain snapshots exist only once the program upgrade in upstream PR #23 is
deployed. Until then, and for every receipt written before it, the receipt
reads `relay-observed` (when the relay saw the payment settle) or
`not-recorded`.

Only an `on-chain` snapshot is shown as **Spending permission at payment**, in
token units: "4.50 USDC ≤ 5 USDC per payment", "12 of 50 USDC used after this
payment", "Payment 3 of 10" (only with a payment-count cap) and "Paid before
expiry (≈ date)". "Paid before expiry" appears only when the snapshot's expiry
slot is after the receipt's executed slot (the program requires
`expires_at_slot > slot`); otherwise the line reads "Expires ≈ date". Dates are
estimated from slots. Exact base units and slots are under Technical details.

A `relay-observed` read is headed **Spending permission, read after payment**.
Its lines say "read after this payment" ("5 USDC per payment, read after this
payment", "Expires ≈ date, read after this payment") and never claim the
payment met a limit or paid before expiry: the mandate may have been edited
between the payment and the read. A `not-recorded` receipt is headed
**Spending permission today** and shows today's limits.

| Source | Caption |
| --- | --- |
| `on-chain` | Recorded on Solana at payment |
| `relay-observed` | Seen by the ChainPay relay after payment, not stored on Solana. The limits may have changed since the payment. |
| `not-recorded` | Not recorded for this receipt. These are today's limits, not the ones at payment. |

A relay observation that already counts later payments shows neither the spent
amount nor the payment count. Public `/verify` reads only the receipt account:
the relay endpoint needs the owner's session, so a public reader sees
`on-chain` or `not-recorded`. The Allowed stamp refers to this section; it is
still the only policy stamp.

Under it, one line compares the receipt's amount with the mandate as it is
now: "If paid today: within limits", or "If paid today: blocked — {reason}"
for a revoked, paused or expired permission, an amount over today's
per-payment limit, a used-up payment count, or too little allowance left.
Cooldown is not checked. When the mandate cannot be read it says "not checked".

## What was bought

A merchant request can carry an optional `description` (up to 280 characters)
and up to 20 `lineItems` (`label`, optional `amount` in base units, optional
`quantity`). They are signed with the rest of the request, so they are part of
the invoice hash when present; a request without them hashes exactly as before.

When a payment settles a merchant-signed request through the relay, the relay
keeps the request by receipt address. Only the mandate owner's wallet session
can read it back, from `/v1/receipts/<receipt-address>/request`.
`verifyReceiptPurchase(receipt, request)` recomputes the hash against the
receipt's invoice hash, checks the merchant signature (not the request's
expiry, since the payment already happened), and reports any amount, mint, or
recipient the receipt paid differently.

## Order match

On the receipt card this is **Order match** (order · invoice · payment), with
one pill:

| Pill | When |
|---|---|
| Matched | Purchase order: an order is linked to the receipt's permission, a seller-signed invoice verifies against the receipt, and the payment went to the order's expected payee. Budget request: the order is linked and the payment is on Solana; the payee is open |
| Payee differs | The payment went to another account than the order's expected payee, or than the invoice named |
| No invoice | A purchase order is linked but no seller-signed invoice verifies for this payment |
| No order | No order is linked to the permission |

The **order** is the purchase order or budget request the owner accepted (see
[ask an owner for a spending permission](../guides/request-a-permission.md)).
The dashboard stores it against the permission with
`PUT /v1/mandates/{pda}/request` and reads it back with the owner session
(`GET`, owner only). It shows only after its requester signature verifies, it
is for the receipt's token, and, for a budget request, it names the agent that
signed. "Paid to the order's payee" means the receipt's recipient token
account is the expected payee, or the payee's associated token account for the
mint.

**Matched is a check by ChainPay, not a guarantee from Solana.** A permission
does not bind one payee on chain; a payment to someone else settles and is
flagged here.

The owner sees the rows: "Purchase order PO-1042 from Acme Data (name not
verified)" or "Budget request from …", "✓ Invoice signed by seller" with its
reference, description and line items, the payee row, and "✓ Paid on Solana".
A mismatch is a failed line, and a request or order that does not verify shows
nothing from it.

Public `/verify` never fetches request content. The owner can choose **Share
with details**, which builds `/verify/<receipt>#purchase=<base64url signed
invoice>&order=<base64url signed order>` (either part only when it exists).
The fragment is not sent to any server. `/verify` checks the invoice against
the on-chain invoice hash and the order's requester signature, token and agent,
and only then shows the details and the same pill. Which permission an order
was accepted for is recorded by the relay, not on Solana, and `/verify` says
so. Without such a link, `/verify` shows no order and no new rows.

## Duplicate invoices

The receipt address is derived from mandate and invoice hash, so an invoice can
be paid once per mandate. The SDK and relay check for the receipt before
building or relaying a payment and stop with a typed `DuplicateInvoice` error:
"This invoice was already paid. Nothing new was submitted."

## Export

`receiptsToCsv(rows)` writes one CSV. The first columns suit accounting imports
(Date, Description, Amount, Payee, Reference); the rest are ChainPay columns
(Token, Agent, Spending permission, Per-payment limit, Total limit, Spent
after, Limits source, Receipt, Verify URL, Explorer URL, PO number, Order
match). PO number and Order match are appended last so earlier imports keep
their columns; they are filled from the owner's view and empty when there is no
order or the check could not run. Amounts are exact
decimals from base units, and amounts whose mint decimals are unknown stay
labeled base units. Dates come from the executed slot's block time and are
left empty when unknown. Cells that a spreadsheet would run as a formula are
prefixed with an apostrophe. The MCP `export_receipts` tool returns this CSV
for the connected wallet. In the dashboard, **Export CSV** on the Receipts tab
downloads `chainpay-receipts-YYYY-MM-DD.csv`; from a terminal,
`chainpay export --owner <wallet> [--out file]` writes the same file (limits
from the on-chain snapshot only, and PO number and Order match left empty,
since the CLI has no relay session). The **Statement** in a permission's
detail panel downloads `chainpay-statement-<mandate>-YYYY-MM-DD.csv` with only
that permission's receipts.

## Optional seller statement

A seller can sign a statement that a response was served. The backend accepts
it only after checking the configured seller mapping and a matching settled
receipt. See [trusted sellers](../guides/trusted-sellers.md).

The signature establishes what the configured seller stated. It does not
prove buyer acceptance, content quality, or a refund entitlement. Missing or
invalid seller evidence leaves the independently verified payment state intact.

## Share and print

The receipt's public link lets another reader inspect chain evidence without
your private wallet session. Use a public deployment that supports the route;
a localhost link only works on your machine.

Printed receipts must retain exact amounts and clearly label evidence that is
absent or unavailable. Never replace verification with a screenshot of a Paid
badge. For uncertain in-flight transactions, follow [settlement recovery](settlement-recovery.md).
