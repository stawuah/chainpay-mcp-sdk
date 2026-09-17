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

The public reader may also show **current** mandate state. A mandate can change
or be revoked after payment. Its current limits are not a historical snapshot
of the policy that applied when the receipt was created.

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
