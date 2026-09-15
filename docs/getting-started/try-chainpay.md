# Try ChainPay on Devnet

The [hosted app](https://chainpay-frontend.onrender.com/) currently shows an
earlier interface. [Run this fork locally](local-development.md) for the
onboarding described below.

On **2026-09-15**, the hosted frontend and backend/MCP health endpoints were
reachable; the landing page showed “The universal rail for agent money.”
That check did not establish the deployed commit or complete a payment.
If a service is unavailable, use [troubleshooting](troubleshooting.md).

## Before you start

- A Solana wallet that supports Devnet and message signing. The app links to
  supported wallet providers if none is detected.
- Devnet SOL in the wallet for transaction fees and account creation.
- A balance of a supported **Devnet** token in its token account. Mainnet
  balances do not appear on Devnet. See [networks and assets](../reference/networks.md).
- The recipient’s **wallet address**. If their associated token account for the
  selected mint does not exist yet, the dashboard asks you to review and sign a
  separate ATA creation step before payment preparation. See
  [token accounts](../reference/token-accounts.md).

This guide uses **human approval**: you review and sign each payment. You can
inspect the app without paying. Account creation and mandate creation are
separate on-chain transactions and require your approval too.

### Need test tokens?

For a USDC walkthrough, use the official [Solana Devnet faucet](https://faucet.solana.com/)
for test SOL and [Circle testnet faucet](https://faucet.circle.com/) with **USDC**
and **Solana Devnet** selected. Enter your public wallet address and follow the
faucet's instructions. Check your Devnet balance before continuing; faucets can
be rate-limited. These links do not fund your wallet automatically.

The recipient can prepare their associated account using the same **Prepare
token account** step below with their own wallet and the same mint. They do not
need to create a spending mandate to receive tokens.

## 1. Connect your wallet and sign in

Open the dashboard at `/app`. Choose a detected wallet and connect it.
The next screen asks you to **Sign in** by signing a message.

Connection reveals your public wallet address to the app. The login message
proves you own it and opens a private session. Neither step grants spending
permission. Canceling sign-in leaves you connected; retry only when ready.

**You should see:** the spending-limit setup step after successful sign-in.

## 2. Set a spending permission

From the spending-limit setup step, select **Review mandate** to open the
form. A **mandate** is the on-chain permission that defines
how an agent may spend from your token account.

Choose **Approve each payment**, then set the token, per-payment limit, total
allowance, and expiry. In this mode your wallet is the payment signer.
The recipient is selected for each payment; this form does not set a fixed
merchant allowlist.

For a small test, choose limits and an amount you understand and can fund.
There is no automatic funding step. In the form’s **Source token account**
row, select **Prepare token account**, even if the account already exists.
An existing account is checked; a missing account triggers a separate wallet
transaction to create it, using Devnet SOL for fees and account rent.
Wait for **Source token account ready** or **Source token account prepared**.
This action does not mint or deposit tokens. Before payment, ensure this account
holds enough of the selected Devnet token; its address appears in the form.

Select **Review mandate**. Check the signer, mint, limits, and expiry.
Select **Approve & create mandate** only after reviewing the transaction in
your wallet. This approval creates the permission and limited token delegation.

**You should see:** a finalized mandate with its address and an action to
pay with it. If confirmation is still pending, retain the operation reference.

## 3. Review and approve one payment

Select **Pay with this mandate**, or open **Payments** and choose your mandate.
Fill in **Invoice or payment reference** with a new reference for this payment,
**Amount** in token units, and **Recipient wallet address**. Use the wallet
address, not its token account address. The amount must fit the per-payment
limit, remaining allowance, and source balance.

Select **Prepare payment**. If the recipient ATA is missing, review recipient
wallet, derived ATA, and SOL rent; sign the separate ATA creation transaction
first. Then wait for **Ready to approve**.

Read the review before signing: exact amount, mint, recipient token account,
network, and permission. A wallet address and a token account are different;
see [token accounts](../reference/token-accounts.md) if the destination is rejected.

Select **Approve payment**, then approve only that payment in your wallet.
ChainPay relays the signed
transaction and checks finality and its matching receipt.

**You should see:** a pending state followed by a confirmed payment with the
shared **ReceiptCard** (same as public verify), or an explicit error. A timeout
is an unknown outcome, not proof of failure. Use in-app **Check settlement** /
**Retry same approval** / **Cancel only if unstarted**, or
[settlement recovery](../reference/settlement-recovery.md) for operator detail;
do not create a second payment to clear a waiting state.

## 4. Inspect and share the receipt

The confirmed payment view shows the human **ReceiptCard** directly. Copy the
**Receipt PDA** from the card or inbox. Open **Public receipt** / **Copy receipt
link** to share `/verify/<receipt-address>` — no wallet required for strangers.

Optional readonly baseline (no new signing):

```text
Receipt PDA: 7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q
```

Set `VITE_CHAINPAY_DEMO_RECEIPT_PDA` locally to label landing **See a receipt**
with this baseline; do not set in production Render env without confirming.

Open **Receipts** → **Look up another settlement** to paste any other PDA.
Use **Open transaction** for the finalized signature and Explorer record.

An on-chain receipt is payment evidence. An optional seller statement is
separate evidence that the seller says a response was served; it is not
proof that you accepted the delivery.

**You should see:** the verified receipt or a clear unavailable/not-found
state. If the fork exposes the public route locally but the hosted app does
not, share only a deployment that actually runs that route.

## Next: connect an agent

[Connect an agent](../guides/connect-an-agent.md) to discover tools and use
your approved scope. Delegated signing needs additional provider setup and
live acceptance; completing this human-approval walkthrough does not enable it.
