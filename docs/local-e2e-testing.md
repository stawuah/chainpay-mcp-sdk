# ChainPay hosted end-to-end testing

This runbook tests the real Devnet path with only the frontend running on the
local machine:

```text
Wallet → local frontend → Render MCP → Render backend → ChainPay program → Solana Devnet
                         ↘ Render backend /rpc
```

The backend and MCP services are not started locally in this guide. The local
frontend is only a wallet-facing UI. It uses the deployed service URLs below
for RPC, MCP discovery, policy checks, transaction relay, and payment status.

Use Devnet only. A real wallet signature and real Devnet transaction are still
required for mandate creation and settlement.

## 1. Hosted service configuration

Run this from the repository root:

```bash
export CHAINPAY_BACKEND_URL="https://chainpay-backend.onrender.com"
export CHAINPAY_MCP_BASE_URL="https://chainpay-mcp.onrender.com"
export CHAINPAY_MCP_URL="$CHAINPAY_MCP_BASE_URL/mcp"
export CHAINPAY_RPC_URL="$CHAINPAY_BACKEND_URL/rpc"
export CHAINPAY_PROGRAM_ID="3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4"
export CHAINPAY_FRONTEND_URL="http://127.0.0.1:5173"
```

The deployed endpoints are:

| Service | URL | Purpose |
| --- | --- | --- |
| Backend health | `https://chainpay-backend.onrender.com/healthz` | Backend status and program ID |
| Backend config | `https://chainpay-backend.onrender.com/v1/config` | Public runtime configuration |
| Backend RPC | `https://chainpay-backend.onrender.com/rpc` | POST-only Solana RPC proxy |
| Backend relay | `https://chainpay-backend.onrender.com/v1/payments` | Wallet-signed payment relay |
| MCP docs | `https://chainpay-mcp.onrender.com/docs` | Hosted integration documentation |
| MCP health | `https://chainpay-mcp.onrender.com/healthz` | MCP service status |
| MCP tools | `https://chainpay-mcp.onrender.com/tools` | Browser-readable tool catalog |
| MCP transport | `https://chainpay-mcp.onrender.com/mcp` | Streamable HTTP JSON-RPC endpoint |

If the backend was deployed with `CHAINPAY_HTTP_AUTH_TOKEN`, add this header
to protected `/v1/*` requests:

```bash
export CHAINPAY_AUTH_HEADER="Authorization: Bearer $CHAINPAY_HTTP_AUTH_TOKEN"
curl -fsS -H "$CHAINPAY_AUTH_HEADER" "$CHAINPAY_BACKEND_URL/v1/config" | jq
```

Health checks and the wallet-authorized `/rpc` route do not require this
header. Never put the backend auth token in frontend code or an MCP client
configuration shared with agents.

## 2. Verify the deployed services

Render services may take a moment to wake up. Run:

```bash
curl --retry 5 --retry-delay 2 -fsS "$CHAINPAY_BACKEND_URL/healthz" | jq
curl --retry 5 --retry-delay 2 -fsS "$CHAINPAY_BACKEND_URL/v1/config" | jq
curl --retry 5 --retry-delay 2 -fsS "$CHAINPAY_MCP_BASE_URL/healthz" | jq
curl --retry 5 --retry-delay 2 -fsS "$CHAINPAY_MCP_BASE_URL/tools" \
  | jq '{service, endpoint, tool_count: (.tools | length), tools: [.tools[].name]}'
```

Expected values include:

```text
backend.status = ok
backend.cluster = devnet
backend.program_id = 3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4
mcp.endpoint = /mcp
tool_count = 14
```

The backend RPC route is JSON-RPC over `POST`. Opening
`https://chainpay-backend.onrender.com/rpc` in a browser sends a `GET` and is
not an RPC test. Use a valid Solana method instead:

```bash
curl -fsS -X POST "$CHAINPAY_RPC_URL" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}' \
  | jq
```

The response should contain a numeric `result` slot from Solana Devnet.

## 3. Verify the hosted MCP transport

Initialize the remote MCP session:

```bash
curl -fsS -X POST "$CHAINPAY_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"chainpay-e2e-check","version":"1.0"}}}' \
  | jq
```

List tools through the browser-friendly catalog:

```bash
curl -fsS "$CHAINPAY_MCP_BASE_URL/tools" \
  | jq '.tools | map({name, description})'
```

The same tools are available to an MCP client at:

```json
{
  "mcpServers": {
    "chainpay": {
      "url": "https://chainpay-mcp.onrender.com/mcp"
    }
  }
}
```

Test a read-only protocol call without executing a transaction:

```bash
curl -fsS -X POST "$CHAINPAY_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_protocol_config","arguments":{}}}' \
  | jq
```

If the result reports `found: false`, the service is reachable but the
protocol config PDA has not been initialized for the deployed program on
Devnet. That is an on-chain bootstrap issue, not a frontend, MCP, or RPC
availability issue.

The agent prompt for the same check is:

```text
Use ChainPay to inspect the protocol config, then quote a payment for this demo invoice without executing it.
```

## 4. Start only the local frontend

The frontend already defaults to the hosted URLs, but pass them explicitly to
avoid testing an old local configuration:

```bash
VITE_CHAINPAY_BACKEND_URL="$CHAINPAY_BACKEND_URL" \
VITE_CHAINPAY_RPC_URL="$CHAINPAY_RPC_URL" \
VITE_CHAINPAY_MCP_URL="$CHAINPAY_MCP_URL" \
npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173
```

Open:

```text
http://127.0.0.1:5173
```

Do not start any of these for this hosted test:

```text
cargo run -p chainpay-backend
npm --prefix mcp-server run dev:http
```

The Vite development proxy also targets the deployed backend, but the explicit
environment variables above make the browser configuration visible and
deterministic.

## 5. Create and inspect a real mandate

Before signing, confirm that the protocol config contains the selected mint.
The bootstrap defaults are:

```text
Devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
Token-2022 Devnet test/PYUSD mint: CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM
```

Use `get_protocol_config` and `get_asset` through the hosted MCP endpoint as
the source of truth before using either mint. The user wallet must have Devnet
SOL for fees and a balance of the selected token.

In the local frontend:

1. Connect a Devnet wallet.
2. Open `Mandates`.
3. Select `+ New mandate`.
4. Enter the approved agent wallet and spending limits.
5. Select USDC or the registered Token-2022 asset.
6. Use `Prepare wallet` when the source token account does not exist.
7. Select `Review mandate` to build and simulate the transaction through the hosted RPC.
8. Select `Sign & create mandate` and approve the real Devnet transaction in the wallet.

The review step does not submit anything. The wallet approval step creates the
on-chain mandate. Refresh the dashboard after confirmation and verify the
mandate PDA through MCP:

```bash
curl -fsS -X POST "$CHAINPAY_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_mandate","arguments":{"address":"REPLACE_WITH_MANDATE_PDA"}}}' \
  | jq
```

## 6. Run a real payment settlement

The payment flow uses the deployed services in this order:

```text
Frontend → hosted MCP prepare_payment → hosted backend /rpc
         → wallet signs → hosted backend /v1/payments
         → Solana Devnet → receipt PDA
```

Before starting, have:

- an active mandate;
- a source token account for that mandate’s mint;
- a recipient wallet address;
- enough token balance for the payment;
- Devnet SOL for the wallet fee payer.

Each new mandate receives a fresh on-chain identity. This means a wallet can
create another USDC mandate after pausing or revoking an older one; the frontend
discovers all mandate accounts and shows their individual IDs for selection.

In `Payments`:

1. Enter the invoice/reference, amount, and recipient wallet.
2. Select `Prepare payment`. This performs MCP policy validation and SDK/RPC simulation only.
3. Confirm the recipient, mint, amount, mandate checks, and receipt PDA.
4. Select `Sign & settle payment`.
5. Approve the wallet prompt. This is the real settlement step.
6. Open the returned Solana Explorer transaction and receipt address.

The frontend resolves the recipient wallet to the correct associated token
account for classic SPL Token or Token-2022. If the account does not exist,
the signed transaction can include its creation before the transfer.

For a quote-only agent test, call `quote_payment` or use:

```text
Use ChainPay to quote this payment against my active mandate. Do not sign, relay, or execute anything.
```

For an x402 request, the agent sends the challenge to
`prepare_x402_payment` at the same hosted MCP endpoint. The adapter validates
the challenge and policy, then the wallet remains responsible for signing.
It does not bypass the mandate or become a key custodian.

## 7. Verify the resulting receipt

Use the frontend receipt lookup or call `get_payment` through the deployed MCP
endpoint with the receipt address or invoice hash. The backend status API is:

```text
GET https://chainpay-backend.onrender.com/v1/payments/{payment_id}
```

The final proof is the finalized Solana transaction and the ChainPay receipt
PDA. A successful HTTP response alone is not proof of settlement; wait for the
backend status to become finalized and verify the transaction on Devnet.

## 8. Troubleshooting the hosted path

| Symptom | Check |
| --- | --- |
| Browser `/rpc` appears blank or fails | `/rpc` accepts POST JSON-RPC, not browser GET |
| Frontend shows localhost RPC | Restart Vite after setting `VITE_CHAINPAY_*` variables and inspect the built app configuration |
| MCP `/tools` works but `get_protocol_config` returns `found: false` | Initialize the config PDA and assets for the deployed program on Devnet |
| Payment is rejected before signing | Check mandate status, mint registration, amount limits, recipient token account, and expiry |
| Payment reaches signing but fails | Check token balance, Devnet SOL, source token account ownership, and Token-2022 compatibility |
| Render request times out | Retry after the service wakes, then re-run the health checks |

## Local code checks

These commands validate the repository without starting local backend or MCP
servers and without signing Devnet transactions:

```bash
NO_DNA=1 cargo fmt --all -- --check
NO_DNA=1 cargo test -p chainpay-backend
NO_DNA=1 cargo test -p chainpay --offline
npm run check:sdk
npm run check:mcp
npm run check:frontend
npm --prefix sdk run test
npm --prefix mcp-server run test
npm --prefix frontend run build
```
