# ChainPay universal MCP server

This server exposes ChainPay as a standard MCP tool provider over JSON-RPC
stdio, so MCP-capable LLM clients can discover and call the same payment tools:

- `get_mandate`
- `get_protocol_config`
- `get_asset`
- `get_supported_assets`
- `list_mandates`
- `find_compatible_mandate`
- `create_mandate`
- `create_demo_payment_request`
- `update_mandate`
- `check_payment_requirements`
- `prepare_payment`
- `quote_payment_request`
- `quote_payment`
- `verify_payment_request`
- `prepare_x402_payment`
- `execute_x402_payment`
- `execute_payment`
- `get_payment`
- `wait_for_payment`
- `pause_mandate`
- `revoke_mandate`

The server accepts only public addresses, payment identifiers, and amounts. It
never accepts seed phrases or private keys. `create_mandate`, `pause_mandate`,
and `revoke_mandate` return transactions that must be reviewed and signed by
the owner wallet. `check_payment_requirements` is the required requirements
stage. It checks limits, token and asset-registry support, recipient, expiry,
and mandate/request policy. If details are missing, the assistant returns the
exact fields that the user must provide before it can quote, prepare, or settle
a payment. `prepare_payment` returns a policy-checked transaction plan; the
connected wallet signs it only after the user reviews the request in the web
UI.
`prepare_x402_payment` normalizes an x402 exact challenge into the same
policy-checked flow. `execute_x402_payment` requires an explicit `signingMode`.
Human mode returns or relays a browser-signed transaction. Delegated mode sends
the unsigned wire transaction to Axum, which validates it, asks the
mandate-bound Privy wallet to sign, revalidates the unchanged message, submits
it, verifies the finalized receipt PDA, and retries the resource with an
`X-PAYMENT` proof. The x402 adapter does not custody keys or operate a hosted
facilitator.

`execute_payment` performs SDK preflight first and requires an explicit
`signingMode`. In `human` mode it returns a base64 unsigned transaction, recent
blockhash, and last valid block height for review, or relays a supplied
browser-signed transaction. In `delegated` mode it never accepts a supplied
signature: it sends the unsigned transaction to Axum's authenticated managed
payment endpoint. MCP never loads or accepts a wallet private key or Privy
credential.

Build and run it locally:

```bash
# From the repository root:
npm run check:mcp
npm --prefix sdk run test
npm --prefix mcp-server run test
npm --prefix sdk run build
npm --prefix mcp-server run build
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_BACKEND_URL=http://127.0.0.1:8080 \
node mcp-server/dist/server.js
```

If your shell is already in `mcp-server/`, use the local aliases instead:

```bash
npm run check:mcp
npm run test
npm run test:sdk
```

`npm run check` from `mcp-server/` delegates to the full workspace check.

## Hosted HTTP MCP

The server also exposes a developer documentation preview at `/` (and `/docs`),
the ChainPay logo at `/logo.svg`, MCP Streamable HTTP at `/mcp`, a health
endpoint at `/healthz`, a browser-friendly read-only tool catalog at `/tools`,
the dashboard's AI assistant at `/agent/chat`, and PostgreSQL-backed inbox
history at `/inbox?wallet=<address>`. The assistant uses the
server-side `OPENROUTER_API_KEY` through OpenRouter's OpenAI-compatible Chat
Completions API and can inspect requests, verify signed demo invoices, find a
compatible mandate, quote a payment, and prepare an approval transaction. An
external approved-agent signer can sign that transaction locally and return
only the signed transaction for relay. HTTP agent connections, hashed bearer
tokens, tool-call activity, and chat history persist in PostgreSQL; production
startup refuses to fall back to memory when `DATABASE_URL` is absent. Owner
wallet approval remains explicit. The HTTP process supports POST JSON-RPC requests plus GET event
streams, so a remote MCP client can use a URL such as:

```json
{
  "mcpServers": {
    "ChainPay": {
      "url": "https://payments.example.com/mcp"
    }
  }
}
```

Run the HTTP server locally from this directory:

```bash
./start-http.sh
```

The script builds the SDK and MCP server automatically. Override defaults when
needed:

```bash
CHAINPAY_HTTP_PORT=4000 CHAINPAY_HTTP_AUTH_TOKEN=change-me \
CHAINPAY_BACKEND_URL=http://127.0.0.1:8080 ./start-http.sh
```

For a hosted deployment, deploy the repository root, not only
`mcp-server/`: the MCP package currently consumes the local `sdk/` workspace.
The included root `Dockerfile` builds both packages and starts
`node mcp-server/dist/http.js` on port `3000`. Configure the platform with:

```text
Build command: npm ci --include=dev --ignore-scripts && npm --prefix sdk run build && npm --prefix mcp-server run build
Start command: node mcp-server/dist/http.js
Health check: /healthz
```

Set `CHAINPAY_RPC_URL`, `CHAINPAY_PROGRAM_ID`, `CHAINPAY_BACKEND_URL`,
`DATABASE_URL`, and explicit `CHAINPAY_ALLOWED_ORIGINS` in the host environment.
Set `OPENROUTER_API_KEY` and `CHAINPAY_AI_PROVIDER=openrouter` to enable the
assistant. Private traffic requires a wallet session or scoped connection;
shared service tokens and blank-token configurations cannot authorize callers.
Use HTTPS for hosted endpoints. See PR01 caller authorization below.

Render is also supported through the root [render.yaml](../render.yaml)
Blueprint. In Render, choose **New → Blueprint**, connect this repository, and
provide the `CHAINPAY_RPC_URL` and explicit allowed frontend origins
when prompted. Render will use `/healthz` for health checks and expose the MCP
endpoint at `https://<service-name>.onrender.com/mcp`.

To smoke-test the MCP protocol without an MCP client, run this from the
repository root after building:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | CHAINPAY_RPC_URL=https://api.devnet.solana.com node mcp-server/dist/server.js
```

An MCP client can launch the development command with:

```json
{
  "mcpServers": {
    "chainpay": {
      "command": "node",
      "args": ["/absolute/path/to/umbral/mcp-server/dist/server.js"],
      "env": {
        "CHAINPAY_RPC_URL": "https://api.devnet.solana.com"
      }
    }
  }
}
```

For a hosted MCP client, use the deployed ChainPay endpoint directly:

```json
{
  "mcpServers": {
    "chainpay": {
      "url": "https://chainpay-mcp.onrender.com/mcp"
    }
  }
}
```

Safe payment demo prompt:

```text
Create a valid Devnet PYUSD demo invoice, verify its merchant signature, find
my compatible mandate, quote it, prepare the payment, and stop for my wallet
approval. Do not sign or submit anything yourself.
```

Paste the configuration into your MCP client settings. The config location
belongs to the client, not to this repository; Claude Desktop and Cursor each
have their own MCP settings.

After deployment, replace `YOUR-HOST.example.com` with the HTTPS hostname and
keep the `/mcp` suffix. The health check is the same hostname with `/healthz`.
To inspect the deployed tool definitions directly in a browser, open the same
hostname with `/tools`. This endpoint returns the same schemas exposed by
MCP's `tools/list` method and does not execute tools or submit transactions.

## PR01 caller authorization

Private HTTP routes require an owner wallet session from Axum or an active
scoped connection. `/connections` registration/list/revoke, `/inbox`, and
`/agent/chat` require an owner session and derive the wallet from it. Supplying
another wallet address returns 403 before inbox persistence or model work.
Each MCP request has its own context; nested chat tools pass the same central
permission check. No empty-token or shared-service-token bypass exists.

Register connections after wallet login, selecting an owned mandate and an
explicit list of permitted tool names. The `scope` field is a JSON string:
`{"version":1,"mandates":["<mandate>"],"tools":["get_mandate"],"agents":{}}`.
The server fills `agents` from the on-chain approved agents. Agent connections
cannot invoke owner-management tools. Existing `Unscoped` connections must be
reconnected. Copy the returned bearer token into the MCP client configuration;
it is displayed once and stored hashed. Public documentation, health and tool
catalog remain available without a token.

For stdio private calls, configure `CHAINPAY_BACKEND_URL` and
`CHAINPAY_CALLER_TOKEN` with the actual owner session/scoped connection token.
`CHAINPAY_BACKEND_AUTH_TOKEN` and `CHAINPAY_HTTP_AUTH_TOKEN` are not caller
identities. HTTP forwards each caller's credential to Axum automatically.

Hosted x402 fetches require exact trusted merchant origins in
`CHAINPAY_X402_ALLOWED_ORIGINS` (comma-separated). HTTPS is required. The explicit
`CHAINPAY_X402_ALLOW_HTTP=true` development option only permits localhost or
loopback HTTP merchants. Redirects remain blocked and responses bounded.
This adapter's receipt-PDA proof is a ChainPay-specific x402 flow; it does not
claim standard sponsor-partially-signed x402 transaction interoperability.
