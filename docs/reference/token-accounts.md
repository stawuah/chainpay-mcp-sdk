# Wallets, token accounts, and recipients

A wallet address identifies an owner. Tokens live in separate **token accounts**,
each associated with one mint. An associated token account (ATA) is the standard
account address derived from an owner, mint, and token program.

```text
Owner wallet
  ├─ USDC source token account → recipient's USDC token account
  └─ PYUSD source token account → recipient's PYUSD token account
```

The mint, token program, and network must match throughout a payment. SOL pays
network fees and account rent; it is separate from the token amount being sent.

## Prepare the owner's source account

In the mandate builder, **Prepare token account** checks the selected mint and
derives the connected wallet's ATA. If a valid account already exists, the UI
shows **Ready**. If it is missing, the wallet is asked to sign account creation,
which requires Devnet SOL for fees and rent.

Creating an account does not fund it, create a mandate, or authorize spending.
The source must separately hold enough of the selected token. A zero token
balance cannot fund a payment even when the account is ready.

## Approve the spending permission

The owner reviews the source, mint, signer, limits, and expiry, then signs the
mandate creation and token-delegate approval. The mandate PDA is the token
account's delegate; the approved agent is the signer that requests payment.

| UI choice | Payment signer |
| --- | --- |
| **Approve each payment** | Connected owner wallet signs each payment. |
| **Automatic payments** | Provisioned managed signer signs within the approved mandate; provider setup is required. |

The payment tokens remain in the owner's source account. The delegated signer
needs SOL for fees and receipt rent, not custody of those tokens. A source token
account has one active delegate: approving another mandate on the same source
can make the previous mandate unusable until the owner changes its delegation.

## Enter the right recipient address

| Surface | Address expected |
| --- | --- |
| Dashboard **Recipient wallet address** | Recipient's Solana wallet address; the UI derives its ATA for the selected mint/program. |
| Dashboard review **Recipient token account** | The actual resolved destination that the transaction will use. |
| SDK/MCP payment `recipient` | An existing recipient **token account** for the exact mint/program. |
| Custom ChainPay x402/1.0 `payTo` | A recipient **token account**, not a wallet address. |

The dashboard resolver can also recognize an existing token account entered
directly. Subsequent payment checks validate its mint and program. Do not assume
this wallet-resolution behavior exists in the SDK or MCP tools.

### If the recipient account is missing

The dashboard shows a **separate review step** before payment preparation:
recipient wallet, derived ATA, SOL rent/fees, and an explicit wallet sign for
ATA creation. Only after that confirmation does payment preparation run
**without** prepending the create instruction into the settlement transaction.

Creating a destination account is a separate wallet-signed operation with fees
and rent. See [local setup](../getting-started/local-development.md) for the
supported development environment before attempting a payment.

## Check the review before signing

1. Compare the selected mandate, mint, and exact amount. UI amounts use verified
   decimals; SDK/MCP amounts are integer base units.
2. Confirm the **Recipient token account** resolves to the intended recipient
   for this mint and network.
3. Require valid policy and account checks, including source balance, active
   delegate, token compatibility, expiry, and remaining limits.
4. Use the expected signer and inspect settlement status after submission.
   On a timeout, look up the existing payment instead of paying again.

After settlement, the receipt records the source and recipient token accounts,
amount, and mint. It proves a token transfer, while delivery needs separate
[evidence](./receipts.md). For the program's enforcement details, read
[How settlement works](./settlement.md).

Implementation reference: [dashboard labels and payment preparation](../../frontend/src/dashboard/Dashboard.tsx),
[address resolution](../../frontend/src/owner/runtime.ts), and
[SDK token capability checks](../../sdk/src/token-capabilities.ts).
