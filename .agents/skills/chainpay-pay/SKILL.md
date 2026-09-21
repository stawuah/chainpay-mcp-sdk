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

Owner creates the scoped token in the dashboard **Agents → Connect agent** flow. Copy the configuration and **first prompt** from the finish card. Never paste tokens or private keys into chat.

Local stdio fallback: build `mcp-server/dist/server.js` and set `CHAINPAY_RPC_URL`, `CHAINPAY_BACKEND_URL`, `CHAINPAY_CALLER_TOKEN`.

## First prompt (after dashboard connect)

Send a read-only prompt like this (replace names and mandate PDA):

```
You are connected to ChainPay as "Invoice agent".

Start read-only:
1. Confirm ChainPay tools are available (tools/list).
2. Call get_mandate with address "MANDATE_PDA" for the connected spending permission.
3. Report in plain language: mandate status, token, remaining allowance, per-payment cap, and what I can ask next.

Do not prepare, sign, or submit a payment until I explicitly ask.
```

## Read-only first

1. `get_protocol_config`
2. `get_spend_overview` for remaining allowance and recent receipts, or `get_mandate` / `list_mandates` if that tool is missing
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

Only when `CHAINPAY_X402_ALLOWED_ORIGINS` includes the merchant origin.

### MPP (WWW-Authenticate: Payment)

Returns `mpp_unsupported`. Use pay.sh for debugger.pay.sh and MPP sandbox APIs.

## Other tools (when needed)

- `check_payment_requirements` — before paying from a merchant-signed request
- `prepare_x402_payment` — when you already hold the 402 JSON body
- `get_spend_overview` / `list_receipts` — spend, remaining allowance, and receipt history without the dashboard
- `get_payment` / `wait_for_payment` — after settlement
- `create_mandate` — owner-signed; agent does not call without explicit owner approval

## Hard rules

- Never accept private keys, seed phrases, or MCP connection tokens from user text
- Never split payments to evade limits
- Timeout ≠ permission to pay again; inspect `paymentId` first
- pay.sh catalog URLs are for **limit estimates** in the dashboard; live price comes from the 402 challenge

## Presentation contract (when talking to the owner)

- Lead with one status sentence; use human amounts from `display.amounts`, not base units
- Hide full addresses unless the owner asks for technical details
- If there is a choice, present numbered options and wait
- End with at most one next step
- Relay MCP tool result cards; never dump raw JSON or unsigned transactions as the headline

## AP2 mental model (documentation only)

- `create_mandate` ≈ Intent Mandate (what the agent may spend)
- `execute_payment` / `execute_x402_payment` ≈ Cart/settlement (this purchase)
- ChainPay enforces on-chain; AP2 crypto is not implemented here
