# ChainPay x402 demo merchant

This server is the independent resource-side half of the standard x402 v2
acceptance flow. `GET /data` returns `HTTP 402` with a standard
`PAYMENT-REQUIRED` response. On retry it sends the submitted payment to the
configured facilitator for verification and settlement; only then does it
return `200` with a standard `PAYMENT-RESPONSE`.

Copy `.env.example` values into your environment and provide the merchant's
normal Solana wallet address in `CHAINPAY_X402_PAY_TO`. The SVM x402 scheme
derives the correct USDC/PYUSD associated token account; users never paste a
token-account address. For local HTTP testing, the MCP process must set
`CHAINPAY_X402_ALLOW_HTTP=true`; deployed resources should use HTTPS.

```bash
npm --prefix demo-merchant run dev
```

This service never holds a payer key. The configured facilitator signs as fee
payer and submits the payment only after the user explicitly signs the direct
transfer. A local `402`, or a unit test, is not settlement. A real acceptance
run requires Corbits to advertise the specific Devnet token capability and to
return a successful `PAYMENT-RESPONSE`.
