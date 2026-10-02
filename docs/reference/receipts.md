# Receipts and seller evidence

A receipt makes a settled ChainPay payment inspectable. Payment evidence and
seller delivery evidence are separate; the UI must show which was verified.

## Read a receipt

Open a receipt from payment history, owner deep link `/app/receipts/<receipt-address>`
when signed in, or visit `/verify` to paste a PDA / `/verify/<receipt-address>`
on a deployment running this fork. The public verification page needs no connected
wallet. Landing **See a receipt** routes to the same flow. The
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

The receipt card shows this as **Spending permission at payment**, in token
units: "4.50 USDC ≤ 5 USDC per payment", "12 of 50 USDC used after this
payment", "Payment 3 of 10" (only with a payment-count cap) and "Paid before
expiry (≈ date)", where the date is estimated from slots. Exact base units and
slots are under Technical details. A caption names the source:

| Source | Caption |
| --- | --- |
| `on-chain` | Recorded on Solana at payment |
| `relay-observed` | Seen by the ChainPay relay after payment, not stored on Solana |
| `not-recorded` | Not recorded for this receipt. Showing today's limits. |

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

On the receipt card this is **Order match** (order · invoice · payment). It is
shown only when a signed request verifies: "✓ Invoice signed by seller" and
"✓ Paid on Solana", with the seller's invoice reference, description and line
items for the owner. A mismatch is a failed line, and a request that does not
verify shows nothing from it. There is no purchase order yet, so the pill
reads "No order", or "Payee differs" when the receipt paid another account
than the invoice named.

Public `/verify` never fetches request content. The owner can choose
**Share with details**, which builds `/verify/<receipt>#purchase=<base64url
signed request>`. The fragment is not sent to any server. `/verify` decodes it,
runs `verifyReceiptPurchase` against the on-chain invoice hash, and only then
shows the details. Without such a link, `/verify` shows no purchase content and
no Order match.

## Duplicate invoices

The receipt address is derived from mandate and invoice hash, so an invoice can
be paid once per mandate. The SDK and relay check for the receipt before
building or relaying a payment and stop with a typed `DuplicateInvoice` error:
"This invoice was already paid. Nothing new was submitted."

## Export

`receiptsToCsv(rows)` writes one CSV. The first columns suit accounting imports
(Date, Description, Amount, Payee, Reference); the rest are ChainPay columns
(Token, Agent, Spending permission, Per-payment limit, Total limit, Spent
after, Limits source, Receipt, Verify URL, Explorer URL). Amounts are exact
decimals from base units, and amounts whose mint decimals are unknown stay
labeled base units. Dates come from the executed slot's block time and are
left empty when unknown. Cells that a spreadsheet would run as a formula are
prefixed with an apostrophe. The MCP `export_receipts` tool returns this CSV
for the connected wallet. In the dashboard, **Export CSV** on the Receipts tab
downloads `chainpay-receipts-YYYY-MM-DD.csv`; from a terminal,
`chainpay export --owner <wallet> [--out file]` writes the same file (limits
from the on-chain snapshot only, since the CLI has no relay session).

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
