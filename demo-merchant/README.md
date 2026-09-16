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

## Run locally

First complete the root dependency install in
[local development](../docs/getting-started/local-development.md). Run these
commands from the repository root. The process does not automatically load
`demo-merchant/.env`; the [example](.env.example) is a configuration reference.

Replace the two placeholders with a real Devnet recipient **token account**
and the public key of the approved agent. The recipient account must belong
to the selected mint. The default amount is `100000` base units (0.1 Devnet
USDC at six decimals).

```bash
CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT=REPLACE_WITH_TOKEN_ACCOUNT \
CHAINPAY_X402_ALLOWED_AGENT=REPLACE_WITH_AGENT_PUBLIC_KEY \
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
PORT=3402 \
npm --prefix demo-merchant run dev
```

Startup queries the live asset registry and fails if the mint is disabled or
the token program differs. Success prints a listening message for
`http://127.0.0.1:3402/data`. The server binds to loopback.

In another terminal:

```bash
curl -i http://127.0.0.1:3402/data
```

**Expected:** HTTP `402` and an `X-Payment-Required` challenge. This checks the
unpaid resource, not settlement. Do not use `curl -f` here: 402 is intentional.
For local HTTP testing through MCP, set `CHAINPAY_X402_ALLOW_HTTP=true` in the
MCP process. Deployed resources should use HTTPS and MCP's explicit
`CHAINPAY_X402_ALLOWED_ORIGINS` allowlist.

## Settlement proof and optional seller statement

This service never signs or submits a payment. A real custom-flow acceptance
run still requires explicit wallet/external-signer approval and a confirmed
Devnet transaction; a local 402 response or invalid-proof test is not
settlement. Successful `200` bodies are hashed after `finish`. When
`CHAINPAY_SELLER_SECRET_KEY` and `CHAINPAY_BACKEND_URL` are set, the merchant
signs the SDK `chainpay.response-served` payload and POSTs the identical
envelope to Axum `POST /v1/delivery-attestations`. Early close, 402, and
verify failure publish nothing. A publication outage leaves the statement
absent; Paid is unchanged. The signing secret stays on this host. The public
seller key must match backend `CHAINPAY_TRUSTED_SELLER`. Do not put a live
secret in git. Tests use the SDK 32-byte `0x07` fixture seed.

Transaction proof reads use the SDK's official legacy/v0/v1 wire decoder on
bounded base64 RPC results, with canonical message checks. RPC trust is
required for chain inclusion; signatures alone do not prove the transaction
landed. This verifies the custom ChainPay receipt proof. It is not a claim
of standard x402 facilitator or sponsor-transaction interoperability.

## Tests and further reading

```bash
npm --prefix demo-merchant test
```

Tests use local fixtures and do not broadcast payments. Configure optional
seller statements using the [trusted-seller guide](../docs/guides/trusted-sellers.md).
For approved end-to-end acceptance, use the
[Devnet runbook](../docs/project/local-e2e-testing.md).
