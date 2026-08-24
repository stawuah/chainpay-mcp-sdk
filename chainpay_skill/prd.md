# ChainPay — Product Requirements Document
**Version:** 0.3.0-devnet
**Status:** Active Development
**Last updated:** August 23, 2026
**Owners:** Kwasi Awuah (backend + smart contract), BR1ANTT_ (MCP/AI + frontend)

---

## 1. What ChainPay Is

ChainPay is an **open payment protocol with a hosted platform layer** for AI agents.

> "Give agents limits. Not your keys."

**Protocol underneath. Platform on top.**

- The **ChainPay Protocol** is an open specification: mandate format, policy rules, authorization interfaces, receipt format, connector interface, agent identity model, payment lifecycle. Anyone can implement it.
- The **ChainPay Platform** is the infrastructure you operate: MCP server, backend relay, frontend dashboard, connectors, AI inbox.
- **Connectors** are pluggable implementations: x402 (any compliant server), Lobster.cash (card layer), Xona Agent, future rails.

ChainPay does not custody funds. ChainPay does not hold private keys. The Anchor program is the only authority.

---

## 2. Who ChainPay Serves

### Primary users
| Persona | Role | What they do |
|---|---|---|
| **Developer / Builder** | Sets policy | Creates mandates, configures spending limits, approves agents |
| **AI Agent** | Executes policy | Makes payments within mandate limits, settles via x402 or direct |
| **Merchant / Resource** | Receives payment | Exposes x402-gated resources, receives USDC/PYUSD, verifies receipts |

### Secondary users
| Persona | Role |
|---|---|
| Enterprise team | Manages agent fleet via dashboard |
| Agent framework builder | Integrates ChainPay MCP into their agent runtime |
| Protocol implementer | Runs their own ChainPay-compatible node |

---

## 3. Core Feature Set

### Feature 1.0 — Policy & Mandate Engine ✅ LIVE (devnet)
Human creates a mandate:
- Approved agent identity
- Source token account
- Mint (allowlisted classic SPL Token or compatible Token-2022; USDC and PYUSD are the Devnet regression assets)
- Per-payment limit
- Total spend limit
- Payment count cap
- Cooldown period
- Expiry
- Pause / resume / revoke

**Rule:** Mandate is enforced atomically by the Anchor program. No off-chain check can override it.

---

### Feature 1.1 — Human Approval Mode ✅ LIVE (devnet)
Every payment requires human wallet signature.

Flow:
```
Agent identifies payment → MCP prepares transaction →
Returns to browser → Human wallet signs →
Backend validates + submits → Anchor executes →
Receipt PDA created → Agent receives confirmation
```

**Rule:** ChainPay platform never sees a private key in this mode.

---

### Feature 1.2 — Managed Delegated Wallet Mode 🔧 IN PROGRESS
Human creates a mandate and optionally provisions a managed signer whose key remains inside an HSM/MPC provider.

Flow:
```
Human opens "Create Mandate with Delegation" →
Owner proves wallet control with a signed challenge →
Axum provisions a provider-held Solana signer →
PostgreSQL stores only provider wallet ID, public address, owner, policy, and status →
User funds delegated wallet with SOL for transaction fees and receipt rent →
USDC/PYUSD remains in the owner's source token account under the mandate PDA allowance →
Anchor mandate created with delegated wallet as approved_agent →
Agent requests a policy-checked provider signature through authenticated ChainPay infrastructure →
Anchor enforces all limits regardless →
Receipt PDA created on every payment
```

**Rules:**
- Browser, MCP, Axum, logs, and PostgreSQL NEVER receive or store the delegated private key
- The managed signer provider must sign without exporting the key and must enforce a ChainPay-only policy
- The Anchor program hard-limits spending regardless of the key
- Future: ZK-based delegation (not in scope now)

---

### Feature 1.3 — Token-2022 Support 🔧 BASE LIVE, EXTENSIONS IN PROGRESS

- Basic Token-2022 `transfer_checked` settlement is live on Devnet through the existing PYUSD flow.
- Any candidate Token-2022 mint may be registered only if owner and extension inspection classifies it as compatible.
- Transfer fees require an explicit gross/net/fee quote and receipt model.
- Transfer hooks require fresh on-chain resolution of their extra accounts for each payment.
- Required-memo mints require memo-aware transaction composition.
- Non-transferable mints and incompatible/frozen accounts are rejected clearly.
- Confidential transfers are a separate proof-based settlement mode; they are not implemented by the current plaintext transfer path.

**Regression rule:** General token support must not change the existing PYUSD
Devnet mint, token-program selection, mandate derivation, delegated allowance,
receipt derivation, or successful settlement behavior.

**Acceptance rule:** No fake or mocked settlement in development or Devnet.
Unit tests may catch regressions, but completion requires a real finalized
Devnet transaction, token balance change, and receipt PDA. Runtime submission
goes directly through Axum to Devnet.

---

### Feature 2.0 — x402 Real Implementation 🔧 IN PROGRESS
ChainPay implements the x402 open protocol natively.

Flow:
```
Agent requests resource →
Resource returns HTTP 402 + payment details header →
ChainPay MCP parses 402 response →
Checks agent mode (1.1 or 1.2) →
  Mode 1.2: signs payment from delegated wallet directly →
  Mode 1.1: returns payment request to human wallet for approval →
Payment settled on Solana →
Receipt PDA created →
Agent retries request with X-PAYMENT proof header →
Resource verifies receipt PDA →
Resource releases content
```

Works with **any x402-compliant server** out of the box.

---

### Feature 2.1 — Lobster.cash Connector 📋 PLANNED
Card-based agent spend routed through Lobster.cash when mandate policy allows card spend.

Flow:
```
Agent payment request →
ChainPay checks policy: card spend allowed? →
Yes → route to Lobster.cash connector →
Lobster.cash executes card payment →
ChainPay records receipt →
Agent confirmed
```

---

### Feature 3.0 — Agent-to-Agent Payments 📋 PLANNED
Agent A (with mandate from Human) creates a sub-mandate for Agent B.

Rules:
- Agent B's sub-mandate cannot exceed Agent A's remaining limits
- Both receipts created on-chain
- Human retains full audit trail
- Anchor program enforces both levels

---

### Feature 4.0 — AI Inbox (Pre-configured Agent) ✅ LIVE (partial)
ChainPay's built-in AI can:
- Read invoices
- Check existing mandates
- Create mandates on behalf of user (human approves)
- Execute payments end-to-end
- Return receipts

Enhancement needed: AI inbox should handle full payment lifecycle from invoice to settlement without manual steps.

---

## 4. What ChainPay Does NOT Do

- ❌ Hold user funds in custody
- ❌ Store private keys on any server
- ❌ Accept payments without on-chain receipt
- ❌ Allow payments that exceed mandate limits (enforced by Anchor, not just UI)
- ❌ Return fake/mock settlement or treat a local fixture as a completed payment

---

## 5. Success Metrics (Colosseum Submission)

| Metric | Target |
|---|---|
| End-to-end x402 payment (devnet) | < 3 seconds |
| Mandate creation to first payment | < 60 seconds |
| Receipt verification | Instant (PDA lookup) |
| Zero failed payments due to policy drift | 100% |
| Zero private keys on server | Verified by code review |
| USDC real settlement | Confirmed Devnet SPL Token transfer and receipt; regression-protected alongside PYUSD |
| Token-2022 support | All registered mints have a declared, tested extension capability profile |
| Agent-to-agent payment demo | Working on devnet |

---

## 6. Out of Scope (Mainnet Release)

- Wallet-signature challenge for MCP connections
- Locking generic relay to ChainPay-only transactions
- ZK-based delegation (Feature 1.2 future)
- Cross-chain settlement
- Fiat off-ramp

---

## 7. Versioning

| Version | Milestone |
|---|---|
| 0.3.0 | Preserve live PYUSD + USDC settlement, x402, and delegated wallet mode |
| 0.4.0 | Lobster.cash connector + agent-to-agent |
| 0.5.0 | DB persistence + Token-2022 extensions |
| 1.0.0 | Mainnet + wallet-signature challenge + relay lockdown |
