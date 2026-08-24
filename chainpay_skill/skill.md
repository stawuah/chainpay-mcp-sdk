# ChainPay — Implementation Skills
**Version:** 0.3.0
**Purpose:** Daily build guide. What to build, how to test it, what done looks like.
**Rule:** Settlement-affecting features require real Devnet acceptance evidence.
No fake or mocked settlement is allowed in development or Devnet. Unit/emulator
tests are regression checks only and never count as settlement.

---

## The Real Loop

For every feature:
```
1. Implement
2. Run unit and program regression tests
3. Verify the existing live PYUSD and USDC baseline read-only
4. If settlement behavior changed, present the Devnet transaction summary and obtain explicit approval
5. Sign externally and submit the reviewed transaction directly through Axum
6. Check finalized status and the token balance change on-chain
7. Decode and verify the receipt PDA
8. Mark done
```

No settlement feature is done until it has a confirmed Devnet transaction
signature. Never sign or submit a transaction without explicit human approval.

---

## Priority Queue (This Week)

### [P0] Remove CHAINPAY_AGENT_SECRET_KEY from MCP Server
**Owner:** BR1ANTT_
**Why:** Violates "no private keys on server" — core protocol rule
**What to do:**
- Delete `CHAINPAY_AGENT_SECRET_KEY` env var handling from `mcp-server/src/index.ts`
- Remove the `autoSign` / automatic-agent code path that uses this key
- Replace with: if mode 1.2, MCP returns an unsigned transaction and the external agent runtime signs locally
- If mode 1.1, return serialized transaction to browser for wallet signing
- Reject any MCP or HTTP argument that contains private-key or seed material

**Test:** Confirm MCP server starts cleanly without any key env vars. Confirm payment tool returns unsigned transaction for browser signing. Confirm no key material in server logs.

---

### [P0] PostgreSQL — Replace All In-Memory Storage
**Owner:** Kwasi
**Why:** Status is ephemeral across restarts — data is lost
**What to do:**
- Add Render PostgreSQL add-on to render.yaml
- Add `DATABASE_URL` env var to backend
- Add `sqlx` or `diesel` to Rust backend
- Create migrations for 4 tables (payments, agent_connections, inbox_messages, x402_payments) — see ARCHITECTURE.md section 7
- Replace `HashMap<String, PaymentRecord>` in backend with DB reads/writes
- Replace `Option<String>` status file with DB
- Add DB connection to MCP server for inbox_messages

**Test:**
1. Submit a real PYUSD payment
2. Restart backend service
3. Query `GET /v1/payments/:id` — status should still be there
4. Check PostgreSQL table directly: `SELECT * FROM payments ORDER BY created_at DESC LIMIT 1;`

---

### [P0] Preserve USDC and PYUSD Real Settlement
**Owner:** Kwasi
**Why:** Both assets already have confirmed Devnet settlements and are the regression baseline.
**What to do:**
- Keep Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` bound to classic SPL Token
- Keep Devnet PYUSD `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` bound to Token-2022
- Do not replace or recreate the PYUSD mint while generalizing asset support
- Verify both `SupportedAsset` PDAs are enabled and bound to the correct token program
- Snapshot the live PYUSD extension set and assert its transfer-fee and transfer-hook configuration before preparing a payment
- Add read-only regression checks for the program, mints, registry entries, and known successful transactions
- After settlement code changes, execute one approved real payment for each affected token-program path

**Test:**
1. Record source and recipient token-account balances through Devnet RPC
2. With explicit approval, execute via the dashboard or external signer
3. Confirm finality and verify exact token-account balance changes
4. Decode the receipt PDA and verify mint, amount, agent, recipient, and status
5. Verify the persisted payment references the same transaction and receipt

---

### [P0] x402 Real Implementation
**Owner:** BR1ANTT_ (MCP tool) + Kwasi (backend endpoint)
**Why:** This is the core protocol integration that validates ChainPay's market position
**What to do:**

**Step A — x402 demo server (for testing)**
Create a simple Express server that:
- Returns HTTP 402 with payment-required header when no X-PAYMENT header
- Verifies receipt PDA on Solana when X-PAYMENT header present
- Returns 200 + data when receipt verified

```typescript
// demo-merchant/src/server.ts
app.get('/data', async (req, res) => {
  const payment = req.headers['x-payment'];
  if (!payment) {
    return res.status(402).json({
      version: "x402/1.0",
      accepts: [{
        scheme: "exact",
        network: "solana-devnet",
        maxAmountRequired: "100000",  // 0.10 USDC
        payTo: MERCHANT_WALLET,
        asset: USDC_MINT_DEVNET,
        resource: req.url,
        maxTimeoutSeconds: 60
      }]
    });
  }

  // Verify receipt PDA
  const proof = JSON.parse(payment as string);
  const receipt = await verifyReceiptPDA(proof.payload.receiptPDA);
  if (!receipt || receipt.amount < 100000) {
    return res.status(402).json({ error: "Payment verification failed" });
  }

  return res.json({ data: "Premium resource content", paidWith: proof.payload.receiptPDA });
});
```

**Step B — MCP execute_x402_payment tool**
```typescript
// mcp-server/src/tools/x402.ts
async function executeX402Payment(params: {
  resource: string,
  paymentRequired: PaymentRequired,
  mandatePDA: string,
  signingMode: 'human' | 'delegated'
}) {
  // 1. Parse payment required
  const accept = selectBestPaymentOption(params.paymentRequired.accepts);

  // 2. Preflight check via SDK
  const mandate = await sdk.getMandate(params.mandatePDA);
  sdk.preflightCheck(mandate, accept.maxAmountRequired, accept.payTo, accept.asset);

  // 3. Build payment transaction
  const invoiceHash = hashX402Invoice(params.resource, accept);
  const tx = await sdk.buildPaymentTransaction({
    mandate: params.mandatePDA,
    amount: BigInt(accept.maxAmountRequired),
    recipient: new PublicKey(accept.payTo),
    invoiceHash,
    mint: new PublicKey(accept.asset)
  });

  // 4. Return an unsigned transaction. The browser wallet (human mode) or
  // external agent runtime (delegated mode) signs it outside ChainPay servers.
  return {
    status: 'prepared',
    signer: params.signingMode === 'delegated' ? 'external-agent' : 'browser-wallet',
    serializedTransaction: tx.serialize({ requireAllSignatures: false }),
    receiptPDA: sdk.deriveReceiptAddress(params.mandatePDA, invoiceHash)
  };
}

// The signer sends only the signed serialized transaction to the Axum backend.
// Axum validates it, submits it directly to Devnet, waits for
// confirmation, verifies the receipt PDA, and only then returns `settled`.
```

**Test:**
1. Start demo merchant server
2. Agent calls `execute_x402_payment` with resource URL
3. Confirm: 402 received → payment built → Solana tx confirmed → receipt PDA exists → retry returns 200
4. Check x402_payments table in DB
5. Verify receipt PDA on Solana Explorer

---

### [P1] Fix Receipt Lookup (Join PDA + TX Signature)
**Owner:** Kwasi + BR1ANTT_
**What to do:**
- Update `get_receipt` MCP tool to:
  1. Fetch ReceiptAccount from Solana (on-chain)
  2. Query `payments` table for matching `receipt_pda` (off-chain)
  3. Return merged response
- Ensure backend stores `receipt_pda` in payments table after finality

**Test:**
1. Execute a real payment
2. Call `get_receipt` with the receipt PDA address
3. Response should include both `onChain.invoiceHash` AND `offChain.transactionSignature`

---

### [P1] Delegated Wallet Mode (Mode 1.2)
**Owner:** Kwasi (Anchor) + BR1ANTT_ (Frontend + MCP)
**What to do:**

**Frontend changes:**
- Add "Create Mandate with Delegation" option
- In browser: `const keypair = Keypair.generate()` (using @solana/web3.js)
- Show private key as base58 in a modal: "Save this — you won't see it again"
- Use `keypair.publicKey` as `approved_agent` in create_mandate instruction
- Show "Fund delegated wallet" step: user sends SOL + token amount to `keypair.publicKey`
- After mandate created, show QR code / copy button for private key to give to agent

**MCP changes:**
- `execute_payment` tool returns an unsigned serialized transaction and required signer address
- Never accept a private key, seed phrase, or keypair bytes in MCP arguments
- Delegated mode is signed by an external agent runtime; human mode is signed by the browser wallet
- Only the signed serialized transaction is sent to the Axum backend

**Anchor changes:**
- None required — approved_agent field already supports any pubkey

**Test:**
1. Create mandate with delegation in frontend
2. Save ephemeral private key
3. Fund delegated wallet (devnet airdrop)
4. Call MCP `execute_payment` to prepare the unsigned transaction
5. Sign locally in the external agent runtime and send only the signed transaction to Axum
6. Confirm: payment executed, receipt created, NO human approval popup
7. Confirm: no server endpoint accepts or logs key material

---

### [P1] Unified Asset Registry
**Owner:** Kwasi
**What to do:**
- Preserve the current payment rule: all asset authorization goes through the enabled `SupportedAsset` PDA
- Do not remove `ProtocolConfig.supported_mints` from the serialized account layout without a versioned migration
- Treat the legacy array as bootstrap metadata only, never as the scalable settlement allowlist
- Add a read-only Devnet verifier and local regression test that prove mint, token program, and enabled status come from `SupportedAsset`

**Test:**
1. Verify the existing USDC and PYUSD registry PDAs without mutating either asset
2. Run a local program test where a mint has an enabled `SupportedAsset` but is absent from the legacy array
3. Confirm payment authorization succeeds through `SupportedAsset`
4. Run a local program test with an unregistered/disabled asset and confirm on-chain rejection
5. Do not alter the live Devnet config array merely to prove this invariant

---

## Skill: x402 Verification (Resource Server Side)

For any server that wants to accept ChainPay x402 payments:

```typescript
import { Connection, PublicKey } from '@solana/web3.js';

async function verifyChainPayReceipt(receiptPDA: string): Promise<boolean> {
  const connection = new Connection("https://api.devnet.solana.com");
  const CHAINPAY_PROGRAM_ID = new PublicKey("YOUR_PROGRAM_ID");

  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(receiptPDA));
    if (!accountInfo || accountInfo.owner.toString() !== CHAINPAY_PROGRAM_ID.toString()) {
      return false;
    }
    // Decode receipt account
    const receipt = decodeReceiptAccount(accountInfo.data);
    // Check not expired, correct amount, correct recipient
    return receipt.amount >= requiredAmount && receipt.recipient === expectedRecipient;
  } catch {
    return false;
  }
}
```

---

## Skill: Mandate Creation (SDK)

```typescript
import { ChainPayClient } from '@chainpay/sdk';

const sdk = new ChainPayClient({ rpcUrl: "https://api.devnet.solana.com" });
const currentSlot = await connection.getSlot("confirmed");

// Build mandate creation transaction
const { transaction } = await sdk.buildCreateMandateTx({
  owner: ownerPublicKey,
  approvedAgent: agentPublicKey,  // mode 1.1: owner's key. mode 1.2: ephemeral key
  mint: USDC_MINT_DEVNET,
  tokenProgram: TOKEN_PROGRAM_ID,  // detect automatically
  sourceATA: ownerSourceATA,
  perPaymentLimit: BigInt(10_000_000),  // $10 USDC
  totalLimit: BigInt(100_000_000),      // $100 USDC
  expiresAtSlot: BigInt(currentSlot + estimatedSlotsForThirtyDays),
  cooldown: 0,
  maxPayments: null
});

// Sign with owner wallet (browser)
const signedTx = await wallet.signTransaction(transaction);
// Submit only through Axum. The backend performs signed-wire validation,
// direct submission, confirmation, and receipt reconciliation before reporting success.
const result = await backend.submitSignedTransaction(signedTx.serialize());
```

---

## Skill: Token-2022 Detection

```typescript
// Always detect which token program owns the mint
async function detectTokenProgram(mint: PublicKey, connection: Connection): Promise<PublicKey> {
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error("Mint not found");

  if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  } else if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    return TOKEN_PROGRAM_ID;
  } else {
    throw new Error("Unknown token program");
  }
}

// Always use transfer_checked (not transfer)
// transfer_checked validates decimals — prevents precision attacks
```

Detection of the token program is only the first gate. Before registration and
again before payment preparation, inspect Token-2022 mint/account extensions and
produce a capability profile:

```
plain transfer_checked       -> supported by the existing path
transfer fee                 -> requires gross/net/fee-aware quote + receipt
transfer hook                -> resolve ExtraAccountMetaList on every payment
required memo                -> prepend the required memo instruction
CPI guard                    -> require delegate compatibility + Devnet proof
non-transferable/frozen      -> reject
confidential transfer        -> route to a separate proof-based flow
unknown transfer-affecting   -> reject until an adapter and real Devnet test exist
```

Never accept arbitrary `remainingAccounts` as proof of compatibility. Resolve
extension accounts from verified on-chain mint configuration and require a
dedicated live Devnet acceptance transaction before enabling a new adapter.

---

## Daily Testing Checklist

Before ending any work session, verify:

```
[ ] For settlement changes, an explicitly approved real Devnet transaction is confirmed
[ ] Existing PYUSD and USDC Devnet baselines remain readable and enabled
[ ] Receipt PDA exists on Solana Explorer for today's payments
[ ] No private keys logged in any server console output
[ ] PostgreSQL payments table has correct records
[ ] MCP tools return expected responses
[ ] Frontend shows correct balance after payment
```

---

## What "Done" Means for Colosseum Submission

```
[ ] USDC real settlement working (like PYUSD)
[ ] x402 end-to-end: 402 → pay → receipt → 200 (all real, no mock)
[ ] Mode 1.1 working: human approval flow
[ ] Mode 1.2 working: delegated wallet autonomous flow
[ ] Agent-to-agent payment working (SubMandate)
[ ] PostgreSQL persisting all payment records
[ ] Receipt lookup returning both on-chain PDA + tx signature
[ ] No private keys on any server
[ ] AI inbox handles full lifecycle: invoice → mandate → payment → receipt
[ ] Demo video: 5 minutes, shows all above flows live on devnet
[ ] GitHub repo: clean, documented, no keys committed
[ ] Colosseum submission: product description + repo + demo video + pitch
```

---

## Environment Variables (Correct Set)

### Backend (Rust)
```
DATABASE_URL=postgresql://...
CHAINPAY_PROGRAM_ID=...
CHAINPAY_RPC_URL=https://api.devnet.solana.com
# NO private keys
```

### MCP Server (Node)
```
CHAINPAY_PROGRAM_ID=...
CHAINPAY_BACKEND_URL=https://chainpay-backend.onrender.com
CHAINPAY_RPC_URL=https://api.devnet.solana.com
OPENAI_API_KEY=...  (or Anthropic key for AI inbox)
# NO CHAINPAY_AGENT_SECRET_KEY — this is removed
```

### Frontend (React)
```
VITE_CHAINPAY_MCP_URL=https://chainpay-mcp.onrender.com
VITE_CHAINPAY_BACKEND_URL=https://chainpay-backend.onrender.com
VITE_CHAINPAY_RPC_URL=https://api.devnet.solana.com
VITE_CHAINPAY_PROGRAM_ID=...
# NO private keys
```
