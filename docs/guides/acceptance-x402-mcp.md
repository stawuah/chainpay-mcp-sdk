# MCP x402 acceptance checklist (J8)

Regression tests and fixtures do **not** count as settlement acceptance. Capture one
explicitly approved Devnet run after Dre authorizes a wallet signature.

## Preconditions

- Devnet wallet with SOL and supported token balance
- Active mandate with approved agent
- Demo merchant or allowlisted origin in `CHAINPAY_X402_ALLOWED_ORIGINS`
- For a standard x402 v2 settlement, that same origin also in `CHAINPAY_X402_RECEIPT_MERCHANTS`
- MCP HTTP with scoped connection token, or stdio with `CHAINPAY_CALLER_TOKEN`
- For v2-shaped merchant challenges: `CHAINPAY_X402_CHALLENGE_SHAPE=v2` on demo-merchant

## Steps

1. `get_mandate` — confirm remaining limit and status
2. `execute_x402_payment` with `resource`, `mandate`, `agent`, `signingMode: human`
3. Sign returned transaction in wallet (or complete delegated path if configured)
4. Confirm `action: x402_verified` and `receipt.address`
5. Open public `/verify/:pda` — receipt card loads without wallet
6. Confirm Axum row exists if backend is deployed (`GET /v1/x402-payments` owner-scoped)

## Evidence to record

- Mandate PDA, receipt PDA, transaction signature
- Resource URL and challenge protocol (`custom` vs `standard-v2` with `settleIfReceiptMerchant`)
- Screenshot or curl of `/verify/:pda`
- Timestamp and Devnet program ID

## Out of scope for this checklist

- pay.sh catalog browse (use pay.sh MCP separately)
- Facilitator-only merchants without receipt verification
- MPP session streaming
- Mainnet
