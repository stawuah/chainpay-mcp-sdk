# Ask an owner for a spending permission

A **permission request** is a signed link that asks a ChainPay owner for a
spending permission (a mandate). There are two kinds:

- **Purchase order** (vendor). "Let your agent pay me up to these limits."
- **Budget request** (builder). "Fund my agent." A grant program or hackathon
  sponsor approves a budget, and the builder's own agent key signs payments.

The link moves no money and creates nothing on Solana. The owner opens it,
reviews it in **Requests**, may change every limit, and approves the result in
their own wallet. Anyone can make a link; the owner decides.

## Vendor: send a purchase order

From a terminal, with a Solana CLI keypair file for your seller key:

```bash
node sdk/dist/cli.js request-mandate --keypair vendor.json --mint <mint> \
  --recipient <payee> --per-payment 5 --total 50 --days 30 \
  --description "Market data API" --po PO-1042 --name "Acme Data"
```

It prints the link and a summary, for example "Asks for up to 5 USDC per
payment, 50 USDC total, 30 days. Payee DobH…jY42. Link valid 7 days." Send the
link to the owner. The key is never printed.

Or run the demo merchant: its `GET /` page, "Pay us with ChainPay", has a
**Request permission** button that calls `POST /mandate-requests` and returns
the same link. See [demo-merchant/README.md](../../demo-merchant/README.md).

`--recipient` is the **expected payee**: your wallet or the token account you
are paid into. ChainPay checks payments against it when it matches receipts.
**Solana does not enforce it.** A permission does not bind one payee on chain,
so a payment to someone else still settles; its receipt reads **Payee
differs** instead of **Matched**.

## Builder: ask a sponsor for a budget

```bash
node sdk/dist/cli.js request-budget --keypair builder.json --agent <agent-key> \
  --mint <mint> --total 50 --days 14 --description "Hackathon API credits" \
  --name "Team Lumen"
```

`--agent` is the key your agent signs payments with. When the sponsor
approves, the permission's approved agent is exactly that key. The sponsor
cannot swap in their own signer for a budget request, and your agent pays
through the MCP external-signer path with its own key. The payee is chosen per
payment.

## What the owner sees

1. The link opens `/app/requests/permission#req=…`. The fragment never reaches
   a server. If the owner is not connected or signed in, the gate renders in
   place and the same URL continues.
2. Requests shows a **PERMISSION REQUEST** card under Needs attention:
   "{name} asks for a spending permission", the stated name with a **Not
   verified** label, the requester key, and "✓ Signature valid" (the key
   only). Token, suggested limits, expiry, and the expected payee or the agent
   that will sign. An expired, edited or damaged link is blocked with the
   reason and nothing from it is used.
3. **Review permission** opens the usual three steps with the request's
   limits. Each limit shows "Requested: 50 USDC"; going above it adds a neutral
   "Above requested" note and is not blocked. The review lists "From request",
   any changed value with "(requested X)", and for a purchase order the
   expected payee with "Payments to anyone else are flagged on the receipt, not
   blocked by Solana." A budget request fixes the approval method to
   **Requester's agent signs**.
4. **Approve spending permission** is the only wallet prompt. After it, the
   dashboard stores the signed request against the new permission
   (`PUT /v1/mandates/{pda}/request`, owner session) and shows "Permission
   created · linked to PO-1042". If that call fails, the permission still
   exists; **Retry link** tries again.
5. **Decline** archives the request in this browser. Nothing was sent to the
   requester.

## After payments

Each receipt under the permission shows **Order match**: Matched, Payee
differs, No invoice, or No order. See [receipts](../reference/receipts.md#order-match).
The permission's detail panel has a **Statement**: budget, spent, left, the
number of payments and the expiry, this permission's receipts with their
Order match, and **Download CSV** for just those receipts. There is no public
statement page.
