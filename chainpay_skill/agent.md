# ChainPay — Agent Guide
**Version:** 0.3.0
**For:** Agent developers, MCP integrators, AI framework builders

---

## What This Document Covers

How AI agents connect to ChainPay, how they make payments, how they interact with x402 resources, and how they can delegate to sub-agents.

---

## 1. Agent Identity Model

An agent in ChainPay is identified by a **public key**. This public key is the `approved_agent` field in a Mandate PDA.

- In **Mode 1.1 (Human Approval):** The agent's public key is typically the user's own wallet (agent = owner). The agent prepares transactions, the human signs them.
- In **Mode 1.2 (Managed Delegated Wallet):** The agent uses a distinct provider-held signer public key. The HSM/MPC provider signs autonomously after ChainPay validates the request, and the Anchor program enforces all limits.

An agent does not have an account on ChainPay. It is simply a public key authorized within a Mandate.

---

## 2. Agent Connection Flow (MCP Required)

An agent MUST connect through MCP before it can use ChainPay tools.

### Step 1: Connect to MCP
```
Transport options:
  stdio:        npx @chainpay/mcp-server
  HTTP:         POST https://chainpay-mcp.onrender.com/mcp
```

### Step 2: Authenticate (current: wallet address string)
```json
{
  "method": "connect",
  "params": {
    "walletAddress": "AGENT_OR_OWNER_PUBKEY"
  }
}
```
> Note: Wallet-signature challenge coming at mainnet. Current devnet uses address only.

### Step 3: Call tools
Once connected, all 21 tools are available. See Architecture PRD section 9 for the catalog generated from the current MCP registry.

---

## 3. Agent Payment Flow — Mode 1.1 (Human Approval)

Used when: Agent does not have a managed delegated signer. Every payment requires human confirmation.

```
┌─────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Agent  │     │   MCP    │     │ Browser  │     │  Anchor  │
└────┬────┘     └─────┬────┘     └─────┬────┘     └─────┬────┘
     │                │                │                 │
     │ prepare_payment│                │                 │
     │───────────────►│                │                 │
     │                │ SDK preflight  │                 │
     │                │ (advisory)     │                 │
     │                │                │                 │
     │                │ serialized tx  │                 │
     │◄───────────────│                │                 │
     │                │                │                 │
     │         return tx to browser    │                 │
     │────────────────────────────────►│                 │
     │                │                │ wallet.sign()   │
     │                │                │────────────────►│
     │                │                │◄────────────────│
     │                │                │ signed tx       │
     │                │                │                 │
     │         signed tx               │                 │
     │◄────────────────────────────────│                 │
     │                │                │                 │
     │ execute_payment│                │                 │
     │ (signed tx)    │                │                 │
     │───────────────►│                │                 │
     │                │ backend relay  │                 │
     │                │ sigVerify sim  │                 │
     │                │ submit         │                 │
     │                │───────────────────────────────► │
     │                │                │      execute    │
     │                │                │      receipt PDA│
     │                │◄───────────────────────────────  │
     │ receipt        │                │                 │
     │◄───────────────│                │                 │
```

---

## 4. Agent Payment Flow — Mode 1.2 (Managed Delegated Wallet)

Used when: the mandate names a provider-held managed signer. Payments can be
autonomous without exposing key material or showing a human popup each time.

```
Agent → MCP prepare_payment({ mandate, amount, recipient })
MCP → builds unsigned transaction and returns the required managed signer
Agent → Axum managed-sign request using its authenticated connection
Axum → loads provider wallet ID from PostgreSQL and validates the full transaction
Axum → HSM/MPC provider signTransaction(unsigned transaction)
Provider → signed transaction bytes (private key is never exported)
Axum → revalidates signer + instructions, submits directly, waits for finality
Anchor → enforces mandate limits, transfers tokens, creates receipt PDA
Axum → returns finalized signature and verified receipt
```

**Key:** PostgreSQL stores only signer metadata and opaque provider IDs. The
browser, MCP, Axum, logs, and database never contain private-key bytes. Provider
API credentials and authorization keys must be protected by a hardware-backed
KMS and provider policies must restrict signing to the ChainPay program.

---

## 5. x402 Agent Flow — End to End

```
Agent wants: https://api.dataservice.com/v1/prices

Step 1: Initial request (no payment)
  Agent → GET https://api.dataservice.com/v1/prices
  ← 402 Payment Required
     X-Payment-Required: {
       version: "x402/1.0",
       accepts: [{
         scheme: "exact",
         network: "solana-devnet",
         maxAmountRequired: "100000",    // 0.10 USDC
         payTo: "Merchant_Wallet_Pubkey",
         asset: "USDC_Mint_Address",
         resource: "https://api.dataservice.com/v1/prices",
         maxTimeoutSeconds: 60
       }]
     }

Step 2: Agent calls MCP
  Agent → MCP: execute_x402_payment({
    resource: "https://api.dataservice.com/v1/prices",
    paymentRequired: <parsed above>,
    mandatePDA: "mandate_pda_address",
    signingMode: "delegated"
  })

Step 3: Agent signs locally and settles on Solana
  MCP checks mandate → preflight → build unsigned tx → agent signs locally
  → Axum backend validates and submits directly to Devnet → Anchor
  → Receipt PDA created at ["receipt", mandate_pda, invoice_hash]

Step 4: MCP returns proof to Agent
  {
    transactionSignature: "5abc...xyz",
    receiptPDA: "9def...uvw"
  }

Step 5: Agent retries with proof
  Agent → GET https://api.dataservice.com/v1/prices
           X-PAYMENT: {
             version: "x402/1.0",
             scheme: "exact",
             network: "solana-devnet",
             payload: {
               signature: "5abc...xyz",
               receiptPDA: "9def...uvw"
             }
           }

Step 6: Resource server verifies
  Resource fetches receipt PDA from Solana RPC
  Confirms: amount ≥ maxAmountRequired, recipient = payTo, not expired
  → 200 OK + resource data

Step 7: MCP returns to Agent
  {
    status: "settled",
    receipt: <ReceiptAccount>,
    resourceResponse: <200 data>
  }
```

---

## 6. Agent-to-Agent Payment Flow

```
Human
  ↓ creates Mandate A (Agent A is approved_agent, limit: $100)
Agent A
  ↓ needs Agent B to handle a sub-task requiring $10
  ↓ calls MCP: create_sub_mandate({
      parentMandatePDA: mandate_a_pda,
      subAgent: agent_b_pubkey,
      limit: 10_000_000,   // $10 USDC
      expiry: <timestamp>
    })
  ↓ SubMandate PDA created: ["sub-mandate", mandate_a_pda, agent_b_pubkey, nonce]
  ↓ Agent A signs (it is approved_agent on Mandate A)

Agent B
  ↓ receives sub_mandate_pda from Agent A
  ↓ calls MCP: execute_payment({
      mandatePDA: sub_mandate_pda,
      amount: 5_000_000,    // $5 USDC
      recipient: merchant_pubkey,
      invoiceHash: "abc123"
    })
  ↓ Anchor enforces:
      SubMandate.amount_spent += 5
      Mandate_A.amount_spent += 5    ← parent always decrements too
  ↓ Receipt PDA created for Agent B's payment
  ↓ Human sees both receipts on dashboard

Agent B cannot spend more than $10 (SubMandate limit)
Agent A cannot let Agent B spend more than $100 total (Mandate A limit)
Human can revoke Mandate A → instantly invalidates SubMandate
```

---

## 7. AI Inbox Agent (Built-in)

ChainPay's built-in AI agent handles the full payment lifecycle.

### Capabilities
- Read and parse invoices (PDF, text, structured data)
- Check existing mandates
- Identify correct mandate for payment
- Create mandate if none exists (presents to human for approval)
- Execute payment (mode 1.1 or 1.2)
- Verify receipt
- Report settlement

### Conversation flow example
```
User: "Pay this invoice from Acme Corp for $50 USDC"
  → AI reads invoice, extracts: recipient, amount, description
  → AI calls get_mandate to find compatible mandate
  → If found: AI calls prepare_payment → presents to user for wallet sign
  → If not found: AI calls prepare_mandate → presents mandate creation to user
  → After mandate approved: AI calls execute_payment
  → AI calls get_receipt and confirms settlement
  → AI reports: "Paid. Receipt: [PDA address]"

User: "What did I spend last week?"
  → AI calls list_mandates + get_receipts
  → Summarizes spend by mandate, recipient, token
```

### What the AI cannot do without human approval
- Create mandates (always requires wallet signature)
- Revoke mandates
- Spend beyond mandate limits (Anchor prevents this regardless)

---

## 8. MCP Integration for External Agent Frameworks

### Claude (via MCP)
```json
{
  "mcpServers": {
    "chainpay": {
      "command": "npx",
      "args": ["@chainpay/mcp-server"],
      "env": {
        "CHAINPAY_OWNER_PUBKEY": "your_wallet_pubkey",
        "CHAINPAY_RPC": "https://api.devnet.solana.com"
      }
    }
  }
}
```

### HTTP MCP (any agent)
```
POST https://chainpay-mcp.onrender.com/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "execute_payment",
    "arguments": { ... }
  }
}
```

---

## 9. Agent Error Handling

All MCP tools return structured errors. Agents must handle:

| Error | Cause | Agent action |
|---|---|---|
| `MandateExpired` | Mandate past expiry | Request human to create new mandate |
| `ExceedsPerPaymentLimit` | Amount > per_payment limit | Split payment or request limit increase |
| `ExceedsTotalLimit` | Would exceed total limit | Request human to create new mandate |
| `MandatePaused` | Owner paused mandate | Wait or notify human |
| `MandateRevoked` | Owner revoked mandate | Request new mandate from human |
| `UnsupportedAsset` | Mint not registered | Use supported mint (USDC, PYUSD) |
| `DuplicateReceipt` | Invoice already paid | Do not retry — payment already settled |
| `AgentNotApproved` | Wrong agent signing | Check mandate's approved_agent field |
| `InsufficientAllowance` | Token account delegate low | Human needs to re-approve allowance |

`DuplicateReceipt` is the most important: the Anchor program uses the receipt PDA as a replay guard. If the agent retries a payment that already settled, Anchor rejects it. The agent should always check `get_receipt` before retrying.
