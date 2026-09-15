# ChainPay x402 demo merchant

This server is the independent resource-side half of the live x402 acceptance
flow. `GET /data` returns `HTTP 402` until `X-PAYMENT` identifies a finalized
ChainPay settlement. It then decodes the receipt PDA from Devnet and verifies
the canonical invoice hash, exact mint, recipient token account, amount,
approved agent, transaction slot, receipt account reference, and successful
`ExecutePayment` log before returning `200`.

Copy `.env.example` values into your environment and provide a real recipient
token account plus the public key of the approved agent. For local HTTP testing,
the MCP process must set `CHAINPAY_X402_ALLOW_HTTP=true`; deployed resources
should use HTTPS.

```bash
npm --prefix demo-merchant run dev
```

This service never signs or submits a payment. A real x402 acceptance run still
requires explicit wallet/external-signer approval and a confirmed Devnet
transaction; a local 402 response or invalid-proof test is not settlement.

Transaction proof reads use the SDK's official legacy/v0/v1 wire decoder on
bounded base64 RPC results, with canonical message checks. This verifies the
existing ChainPay receipt proof; it is not a claim of standard x402 sponsor
transaction interoperability.
