# ChainPay custom receipt-proof demo merchant

This server is the independent resource-side half of ChainPay's **custom**
x402/1.0 receipt-proof flow. The `x402/1.0` label is kept for compatibility
with the existing MCP client. It is **not** standard x402 v2 `exact` SVM:
standard v2 sends a partially signed transaction for a sponsor to
countersign, while this merchant verifies a settled Solana signature plus
ChainPay receipt PDA.

`GET /data` returns `HTTP 402` with a custom challenge until `X-PAYMENT`
identifies a finalized ChainPay settlement. It then verifies the derived
receipt PDA, canonical invoice/payment/signature references, exact mint,
recipient token account, amount, approved agent, first-signature binding,
outer `execute_payment` instruction, and successful finalized transaction
metadata before returning `200`.

Custom challenge `payTo` is the recipient **token account**. Standard x402
v2 `payTo` is a merchant owner (ATA is derived). This server never copies a
v2 owner address into the custom recipient-token-account field. A standard
v2 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` document is detected from its
body (`x402Version: 2`) and rejected as `unsupported-sponsor` before any
signing or settlement path. Header names are not a protocol signal.

Copy `.env.example` values into your environment and provide a real recipient
token account plus the public key of the approved agent. For local HTTP testing,
the MCP process must set `CHAINPAY_X402_ALLOW_HTTP=true`; deployed resources
should use HTTPS.

```bash
npm --prefix demo-merchant run dev
```

This service never signs or submits a payment. A real custom-flow acceptance
run still requires explicit wallet/external-signer approval and a confirmed
Devnet transaction; a local 402 response or invalid-proof test is not
settlement. Successful `200` bodies are hashed for an optional seller
response-served statement (PR-07). Without a configured publisher the
statement is absent and Paid is unchanged. This process does not call Axum.

Transaction proof reads use the SDK's official legacy/v0/v1 wire decoder on
bounded base64 RPC results, with canonical message checks. RPC trust is
required for chain inclusion; signatures alone do not prove the transaction
landed. This verifies the custom ChainPay receipt proof. It is not a claim
of standard x402 facilitator or sponsor-transaction interoperability.
