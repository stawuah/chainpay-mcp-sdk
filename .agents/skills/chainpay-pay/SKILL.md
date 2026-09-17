---
name: chainpay-pay
description: Connect ChainPay MCP, inspect mandate limits, pay HTTPS 402 resources through on-chain policy, and return a public receipt URL. Use when an agent needs to spend stablecoins within owner-approved limits—not for pay.sh catalog search or facilitator-only merchants.
---

# ChainPay agent payments

ChainPay is the **control layer**: mandates, settlement, receipt PDAs. pay.sh is the **catalog + facilitator wrapper** for generic x402/MPP APIs. Run both MCP servers when needed; do not rebuild pay.sh inside ChainPay.

## Connect (prefer hosted HTTP)

```json
{
  "mcpServers": {
    "chainpay": {
      "url": "https://YOUR_MCP_HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SCOPED_CONNECTION_TOKEN"
      }
    }
  }
}
```

Owner creates the scoped token in the dashboard **Connect MCP** flow. Never paste tokens or private keys into prompts.

Local stdio fallback: build `mcp-server/dist/server.js` and set `CHAINPAY_RPC_URL`, `CHAINPAY_BACKEND_URL`, `CHAINPAY_CALLER_TOKEN`.

## Read-only first

1. `get_protocol_config`
2. `list_mandates` with owner wallet, or `get_mandate` with mandate PDA
3. Stop if mandate is paused, revoked, or expired

## Pay a 402 URL (primary verb)

Use **`execute_x402_payment`**:

```json
{
  "resource": "https://allowlisted-merchant.example/data",
  "mandate": "MANDATE_PDA",
  "agent": "APPROVED_AGENT_PUBKEY",
  "signingMode": "human"
}
```

Flow:

1. MCP fetches the URL → HTTP 402
2. Detects protocol: custom x402/1.0, standard x402 v2, or MPP
3. Checks mandate limits
4. Returns unsigned tx (human) or submits delegated path
5. Retries resource with `{ signature, receiptPDA }` proof
6. Return receipt PDA → owner opens `/verify/:pda`

Resume stuck delivery with `{ "paymentId": "payment_..." }` only—never double-settle.

### Standard x402 v2 / pay.sh merchants

Facilitator merchants need **pay.sh** (`pay curl …`). ChainPay returns `x402_unsupported_sponsor` with a **mandate quote** (amount, derived ATA, whether limits allow it).

For **allowlisted receipt merchants** that verify ChainPay receipts despite v2-shaped challenges, set:

```json
"settleIfReceiptMerchant": true
```

The flag only confirms your intent. The operator decides which merchants can settle, by
listing them in `CHAINPAY_X402_RECEIPT_MERCHANTS` — a deliberate subset of the fetch
allowlist, because a merchant being readable is no evidence that it understands a ChainPay
receipt PDA. If the origin is not on that list, you get `x402_unsupported_sponsor` with the
mandate quote no matter what you pass, and nothing is settled. Do not ask the owner to add a
merchant to it in order to get past a refusal.

### MPP (WWW-Authenticate: Payment)

Returns `mpp_unsupported`. Use pay.sh for debugger.pay.sh and MPP sandbox APIs.

## Other tools (when needed)

- `check_payment_requirements` — before paying from a merchant-signed request
- `prepare_x402_payment` — when you already hold the 402 JSON body
- `get_payment` / `wait_for_payment` — after settlement
- `create_mandate` — owner-signed; agent does not call without explicit owner approval

## Hard rules

- Never accept private keys, seed phrases, or MCP connection tokens from user text
- Never split payments to evade limits
- Timeout ≠ permission to pay again; inspect `paymentId` first
- pay.sh catalog URLs are for **limit estimates** in the dashboard; live price comes from the 402 challenge

## AP2 mental model (documentation only)

- `create_mandate` ≈ Intent Mandate (what the agent may spend)
- `execute_payment` / `execute_x402_payment` ≈ Cart/settlement (this purchase)
- ChainPay enforces on-chain; AP2 crypto is not implemented here
