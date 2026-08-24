# ChainPay — Architecture PRD
**Version:** 0.3.0
**Status:** Active
**Owners:** Kwasi Awuah (backend + smart contract), BR1ANTT_ (MCP/AI + frontend)

---

## The Prime Directive

> The Anchor program is the only authority. Every other layer prepares, routes, validates, or displays — but cannot override on-chain enforcement.

> No private keys on any server. Ever.

> No fake or mocked settlement in development, Devnet, or production. A successful
> settlement must have a finalized transaction signature and an on-chain receipt.
> Runtime payment flows do not use simulated settlement or simulated submission.
> Axum submits the reviewed, externally signed transaction directly to Devnet and
> reports success only after finality and receipt verification.

> The Rust HTTP backend remains Axum. A framework rewrite is not part of this plan.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CHAINPAY PROTOCOL                           │
│         (open spec: mandate format, receipt format,             │
│          connector interface, agent identity model)             │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                   CHAINPAY PLATFORM                             │
│                                                                 │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Frontend   │   │  MCP Server  │   │   Rust Backend     │  │
│  │  (React)    │   │  (Node)      │   │   (Axum)           │  │
│  │             │   │              │   │                    │  │
│  │ Dashboard   │   │ 21 tools     │   │ RPC proxy          │  │
│  │ AI inbox    │◄──│ AI agent     │──►│ Tx relay           │  │
│  │ Wallet sign │   │ Policy check │   │ Payment validate   │  │
│  │ Mandate UI  │   │ x402 client  │   │ Status polling     │  │
│  │             │   │ Connector    │   │ PostgreSQL writes   │  │
│  └──────┬──────┘   │ routing      │   └─────────┬──────────┘  │
│         │          └──────┬───────┘             │             │
└─────────┼─────────────────┼─────────────────────┼─────────────┘
          │                 │                     │
          └─────────────────▼─────────────────────┘
                            │
                ┌───────────▼────────────┐
                │   CONNECTOR LAYER      │
                │                        │
                │ x402 (any compliant)   │
                │ Lobster.cash (card)    │
                │ Xona Agent             │
                │ Future rails           │
                └───────────┬────────────┘
                            │
                ┌───────────▼────────────┐
                │   Solana Devnet RPC    │
                └───────────┬────────────┘
                            │
                ┌───────────▼────────────┐
                │   ChainPay Program     │
                │   (Anchor)             │
                │                        │
                │ Mandate enforcement    │
                │ Receipt creation       │
                │ Replay prevention      │
                │ Token transfer CPI     │
                └───────────┬────────────┘
                            │
                ┌───────────▼────────────┐
                │ SPL Token / Token-2022 │
                └────────────────────────┘
```

---

## 2. Component Responsibilities

### 2.1 Frontend (React) — BR1ANTT_
**Owns:**
- Wallet connection (Wallet Standard / Phantom)
- Mandate creation UI (both modes 1.1 and 1.2)
- Managed-signer enrollment for delegated wallet mode (mode 1.2) — the frontend handles only provider IDs and public addresses
- Transaction reconstruction and wallet signature request
- AI inbox UI
- Receipt display
- Mandate management (pause/resume/revoke)

**Does NOT own:**
- Policy enforcement (Anchor owns this)
- Transaction submission or settlement authority
- Any mechanism that reports a preview, local fixture, or database-only state as a settled payment
- Any private key storage

### 2.2 MCP Server (Node) — BR1ANTT_
**Owns:**
- 21 tools exposed over stdio and HTTP /mcp
- AI orchestration (AI inbox chat → tool calls)
- x402 client implementation (sends payment, attaches proof header)
- Connector routing (x402, Lobster.cash, future)
- Policy preflight (advisory only — Anchor is the authority)
- Payment preparation and serialization
- Agent identity verification
- Managed-signer routing by opaque provider wallet ID

**Does NOT own:**
- Private keys of any kind (removed from implementation)
- Final policy authority (Anchor owns this)
- Transaction submission (backend owns this)

The approved-agent key is held by the user's browser wallet in mode 1.1 or by
the configured HSM/MPC signer provider in mode 1.2. MCP receives no key bytes.

### 2.3 Rust Backend (Axum) — Kwasi
**Owns:**
- RPC proxy (allowlisted reads only)
- Transaction relay with validation
- Payment record persistence (PostgreSQL)
- Payment status polling
- Merchant signature verification
- Direct submission of externally signed transactions to Devnet
- Finality waiting

**Does NOT own:**
- Policy decisions (Anchor owns this)
- Wallet signing (browser or delegated wallet owns this)
- AI logic (MCP owns this)

**Storage:** PostgreSQL (replace in-memory + JSON file). Schema below.

### 2.4 ChainPay Anchor Program — Kwasi
**Owns:**
- Everything. Final authority on all payments.
- Mandate creation and state
- Payment policy enforcement (limits, cooldown, expiry, pause)
- Receipt PDA creation (replay prevention)
- Token transfer CPI
- PaymentExecuted event emission

**Asset registry:** `SupportedAsset` PDA is the settlement allowlist. Each entry
binds one mint to its actual owning program: classic SPL Token or Token-2022.
`ProtocolConfig.supported_mints` is a legacy bootstrap field that is not used for
payment authorization. Keep it in the account layout until a deliberate account
migration is designed; do not remove it during token-support work.

---

## 3. Signing Modes (No Keys on Server)

### Mode 1.1 — Human Approval
```
Agent prepares payment intent →
MCP serializes unsigned transaction →
Frontend reconstructs transaction →
Frontend checks live mandate, asset, token-account, balance, and receipt state →
Browser requests wallet signature →
Signed transaction → Backend →
Backend validates the signed wire transaction →
Backend submits directly (skipPreflight: true) →
Anchor executes →
Receipt PDA created
```

### Mode 1.2 — Delegated Wallet
```
[SETUP - one time]
Human opens "Create Mandate with Delegation" in frontend →
Owner proves wallet control with a signed challenge →
Axum provisions a Solana signer with the configured HSM/MPC provider →
Provider returns an opaque wallet ID and public address; no key is exported →
PostgreSQL stores owner, provider wallet ID, public address, policy ID, and status only →
User funds the managed signer with SOL for fees and receipt rent →
Owner keeps the payment token in the mandate's source token account →
Frontend builds create_mandate with the managed signer pubkey as approved_agent →
Human's main wallet signs the create_mandate + approve_checked transaction →
Mandate PDA created on-chain →

[PAYMENT - autonomous]
Agent calls MCP execute_payment tool →
MCP builds transaction →
Axum authenticates the agent and loads the signer reference from PostgreSQL →
Axum validates the exact transaction, then requests provider signing →
Provider returns signed wire bytes without exposing the private key →
Axum revalidates and submits directly →
Anchor enforces limits atomically →
Receipt PDA created
```

**Security properties of Mode 1.2:**
- Browser, MCP, Axum, logs, and PostgreSQL never contain the delegated private key
- Provider policy allows only the ChainPay program and expected Solana instruction shape
- Even if signing access is compromised, Anchor limits total damage to mandate limits
- Mandate can be revoked instantly by owner wallet

---

## 4. x402 Real Implementation

### What x402 is
An open HTTP protocol where a server returns `HTTP 402 Payment Required` with payment details, the client pays on-chain, and retries with proof.

### ChainPay x402 flow (real HTTP challenge + real on-chain settlement)
```
Agent → GET https://resource.example.com/data
         ← 402 Payment Required
            X-Payment-Required: {
              version: "x402/1.0",
              accepts: [{
                scheme: "exact",
                network: "solana-devnet",
                maxAmountRequired: "1000000",  // 1 USDC (6 decimals)
                resource: "https://resource.example.com/data",
                description: "API call",
                mimeType: "application/json",
                payTo: "MERCHANT_WALLET_ADDRESS",
                maxTimeoutSeconds: 60,
                asset: "USDC_MINT_ADDRESS",
                extra: { name: "USDC", version: "1" }
              }]
            }

Agent → MCP tool: execute_x402_payment({
          resource: "https://resource.example.com/data",
          paymentRequired: <parsed 402 header>,
          signingMode: "delegated" | "human"
        })

MCP →  Check mandate exists and covers this payment
MCP →  Build Solana transfer_checked instruction
       (recipient = payTo, amount = maxAmountRequired, mint = asset)
MCP →  Sign (mode 1.2: provider-held managed signer | mode 1.1: return to browser)
MCP →  Submit via backend
MCP →  Wait for receipt PDA confirmation

Agent → GET https://resource.example.com/data
         X-PAYMENT: {
           version: "x402/1.0",
           scheme: "exact",
           network: "solana-devnet",
           payload: {
             signature: "<tx_signature>",
             receiptPDA: "<receipt_pda_address>"
           }
         }
         ← 200 OK + resource content
```

### Resource verification (what the resource server checks)
Resource server fetches receipt PDA from Solana → confirms:
- Receipt exists (not replay)
- Amount matches
- Recipient matches
- Not expired
→ releases resource

### x402 connector interface
```typescript
interface X402Connector {
  // Parse 402 response
  parsePaymentRequired(headers: Headers): PaymentRequired;

  // Execute payment and return proof
  executePayment(
    paymentRequired: PaymentRequired,
    mandate: MandateAccount,
    signingMode: SigningMode
  ): Promise<PaymentProof>;

  // Build retry headers
  buildPaymentHeader(proof: PaymentProof): Headers;

  // Verify receipt (used by resource servers)
  verifyReceipt(receiptPDA: PublicKey): Promise<ReceiptAccount>;
}
```

---

## 5. USDC, PYUSD, and Token-2022 Settlement

USDC and PYUSD share the ChainPay mandate, policy, receipt, relay, and finality
lifecycle, but they do **not** use the same token program.

| Devnet asset | Mint | Token program | Status |
|---|---|---|---|
| USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Classic SPL Token | Enabled; real settlement verified |
| PYUSD Devnet flow | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` | Token-2022 | Enabled; real settlement verified |

Do not replace, recreate, or silently migrate the PYUSD Devnet mint while adding
USDC or generalized Token-2022 support. Mint addresses are cluster-specific
configuration, not symbol-based constants shared across networks.

### Live Devnet regression baseline — August 23, 2026

- PYUSD `execute_payment`: `3yRhnwna13r5SDUsBf2LJdgqGRro7XAGZtaPHbAARfMLbCmQyFS8BWXdyK6qdtpZ48mpc2srvt2UU7LZ63vBLc7`
- USDC `execute_payment`: `6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D`

Both transactions succeeded on Devnet through the deployed ChainPay program and
the correct token program. These signatures are regression evidence, not a
substitute for a new real Devnet acceptance transaction when settlement code is
changed.

The live PYUSD Devnet mint is the primary extension fixture. Its current mint
extensions are `mintCloseAuthority`, `permanentDelegate`, `transferFeeConfig`
(currently 0 bps / maximum fee 0), `confidentialTransferMint`,
`confidentialTransferFeeConfig`, `transferHook` (currently no hook program),
`metadataPointer`, and `tokenMetadata`. The confirmed transparent PYUSD payment
proves the existing delegated `transfer_checked` path works for this exact
configuration. Extension authorities can change fee/hook configuration, so the
SDK must re-read transfer-affecting state before every payment rather than cache
this snapshot permanently.

### General Token-2022 rule

ChainPay supports any **allowlisted, transferable Token-2022 mint whose active
extensions are supported by the transaction builder and receipt semantics**.
Registration must inspect the mint owner and extensions, store a capability
profile, and reject unsupported combinations before a user creates a mandate.

| Extension category | ChainPay handling |
|---|---|
| No transfer-affecting extension | Existing `transfer_checked` path |
| Transfer fee | Zero-fee configuration uses the existing path; nonzero fees require gross amount, net received, and withheld fee to be quoted and recorded correctly |
| Transfer hook | A null hook program uses the existing path; otherwise resolve and validate the on-chain extra-account-meta list for every payment before transaction construction |
| Required memo | Compose the required memo before the transfer and cover it with a dedicated live Devnet acceptance transaction |
| CPI guard | Compatible with ChainPay's delegate-based transfer only after account-level detection and a Devnet acceptance test |
| Non-transferable or frozen account | Reject with a precise compatibility error |
| Confidential transfer | Separate proof-based settlement flow; never claim the plaintext `transfer_checked` path supports it |

Callers may not label arbitrary `remainingAccounts` as extension support. The SDK
must resolve and validate those accounts from the mint's on-chain extension data.

---

## 6. Agent-to-Agent Payments

### Model
Agent A (mandate from Human) → creates SubMandate for Agent B → Agent B spends within SubMandate limits → Both receipts on-chain → Human sees full audit trail

### SubMandate rules (enforced by Anchor)
- SubMandate.total_limit ≤ remaining Mandate.total_limit at creation time
- SubMandate.per_payment_limit ≤ Mandate.per_payment_limit
- SubMandate.expiry ≤ Mandate.expiry
- When Agent B pays: Mandate.amount_spent += payment AND SubMandate.amount_spent += payment (both decremented)
- Revoking Mandate automatically invalidates all SubMandates

### On-chain accounts
```
Mandate PDA ["mandate", owner, mint, nonce]
  ↓ creates
SubMandate PDA ["sub-mandate", mandate_pda, agent_b_pubkey, nonce]
```

---

## 7. Database Schema (PostgreSQL)

Replaces in-memory + JSON file storage.

```sql
-- Payment records (replaces in-memory PaymentRecord)
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_pda TEXT NOT NULL,
  invoice_hash TEXT NOT NULL,
  receipt_pda TEXT,
  transaction_signature TEXT,
  status TEXT NOT NULL, -- pending | confirmed | finalized | failed
  amount BIGINT NOT NULL,
  mint TEXT NOT NULL,
  recipient TEXT NOT NULL,
  agent_pubkey TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finalized_at TIMESTAMPTZ
);

-- MCP agent connections (replaces in-memory map)
CREATE TABLE agent_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- Delegated signer metadata. Private keys and encrypted key blobs are forbidden.
CREATE TABLE managed_signers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_wallet_id TEXT NOT NULL,
  provider_policy_id TEXT,
  mandate_pda TEXT,
  status TEXT NOT NULL, -- provisioning | active | suspended | revoked
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (provider, provider_wallet_id)
);

-- AI inbox history (replaces localStorage)
CREATE TABLE inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- user | assistant | tool
  content TEXT NOT NULL,
  tool_calls JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- x402 payment proofs (new)
CREATE TABLE x402_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID REFERENCES payments(id),
  resource_url TEXT NOT NULL,
  payment_required JSONB NOT NULL,
  proof JSONB,
  status TEXT NOT NULL, -- pending | settled | verified | failed
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 8. Unified Asset Registry

**Current problem:** Two overlapping models — ProtocolConfig.supported_mints (array, not enforced) and SupportedAsset PDA (enforced).

**Fix:** Only SupportedAsset PDA is checked. ProtocolConfig.supported_mints is removed from payment validation logic.

```rust
// In execute_payment: only check this
let asset = &ctx.accounts.supported_asset;
require!(asset.enabled, ChainPayError::UnsupportedAsset);
require!(asset.mint == ctx.accounts.source_ata.mint, ChainPayError::MintMismatch);
require!(asset.token_program == *ctx.accounts.token_program.key, ChainPayError::TokenProgramMismatch);
```

---

## 9. MCP Tools Catalog (21 tools)

### Read tools
| Tool | Description |
|---|---|
| `get_protocol_config` | Protocol config PDA |
| `get_mandate` | Mandate account by PDA |
| `list_mandates` | All mandates for owner |
| `find_compatible_mandate` | Find an active mandate matching a request |
| `get_asset` | One SupportedAsset PDA |
| `get_supported_assets` | All registered mints |
| `get_payment` | Receipt PDA lookup with Axum transaction join |
| `wait_for_payment` | Poll Axum until payment reaches a terminal status |

### Request and payment tools
| Tool | Description |
|---|---|
| `create_demo_payment_request` | Create a merchant-signed Devnet request for the demo workflow |
| `verify_payment_request` | Verify a merchant Ed25519 signature |
| `quote_payment_request` | Verify and quote a signed merchant request |
| `check_payment_requirements` | Return the five deterministic payment gates |
| `quote_payment` | Quote a structured payment without submission |
| `prepare_payment` | Build execute_payment tx with SDK preflight |
| `execute_payment` | Return unsigned transaction or relay one already signed by a browser/external agent runtime |
| `prepare_x402_payment` | Parse 402 + build payment tx |
| `execute_x402_payment` | Full x402 flow: pay + retry + verify |

### Control tools
| Tool | Description |
|---|---|
| `create_mandate` | Build create_mandate + approve_checked tx |
| `update_mandate` | Build an owner-approved mandate update |
| `pause_mandate` | Pause spending |
| `revoke_mandate` | Permanent revoke |

---

## 10. Receipt Lookup Fix

**Current problem:** Receipt PDA exists on-chain, but the transaction signature lives only in the backend record. They're not joined.

**Fix:** `get_receipt` MCP tool returns both:
```typescript
{
  receiptPDA: string,
  onChain: ReceiptAccount,       // from Solana
  offChain: {                    // from PostgreSQL
    transactionSignature: string,
    finalizedAt: string,
    computeUnits: number
  }
}
```

---

## 11. No Fake Settlement Policy

The following acceptance flows are real—not mocked, fabricated, or represented
by a local fixture:

| Flow | Reality check |
|---|---|
| USDC settlement | Real devnet USDC transfer, real on-chain state change |
| PYUSD settlement | Real devnet PYUSD transfer, real on-chain state change |
| x402 payment | Real HTTP 402 → real on-chain payment → real retry → real 200 response |
| Receipt PDA | Real on-chain account, queryable by anyone |
| Mandate creation | Real on-chain PDA, real token account delegation |
| Policy enforcement | Real Anchor program rejection, not just UI warning |

The following checks are useful, but none of them is settlement:
| Check | Purpose |
|---|---|
| SDK preflight | UX preview — warns before wallet signature |
| Frontend balance check | UX — prevents pointless wallet popups |
| Signed-wire validation | Rejects malformed or unsigned payloads before direct submission |
| Unit tests | Fast code regression checks only; never reported as a real payment |

After settlement-affecting code changes, acceptance requires the exact Devnet
mint/program pair, a finalized transaction, verified token balance changes, and
a decoded receipt PDA. No endpoint or UI state may return `settled` from a stub,
timer, local-only record, or fabricated response.

---

## 12. Deployment (Render)

| Service | Type | Notes |
|---|---|---|
| Frontend | Static site | React build |
| Backend | Web service (Rust) | Add DATABASE_URL env |
| MCP server | Web service (Node) | Remove CHAINPAY_AGENT_SECRET_KEY |
| PostgreSQL | Managed DB | Render Postgres add-on |

**Critical:** Remove `CHAINPAY_STATUS_FILE` and all in-memory storage. All state goes to PostgreSQL.

---

## 13. Implementation Priority Order

```
Week 1 (Aug 22-25):
  [1] Lock the live PYUSD + USDC Devnet flows behind regression gates
  [2] Remove CHAINPAY_AGENT_SECRET_KEY from MCP server
  [3] Add PostgreSQL — replace all in-memory storage
  [4] x402 real implementation (MCP tool + connector)
  [5] Fix receipt lookup (join PDA + tx signature)

Week 2 (Aug 28 - Sep 1):
  [6] Delegated wallet mode (Mode 1.2) — managed signer provider + DB reference + Anchor approved_agent
  [7] AI inbox full lifecycle (invoice → mandate → payment → receipt)
  [8] Regression-test SupportedAsset as the sole authorization gate; preserve the legacy config layout
  [9] Colosseum Eternal Sprint submission

Week 3-4 (Sep):
  [10] Lobster.cash connector
  [11] Agent-to-agent SubMandate system
  [12] Token-2022 extension scanner + capability registry
  [13] Transfer-fee, memo, and transfer-hook adapters with real Devnet fixtures
  [14] Confidential transfers as a separate settlement design
```
