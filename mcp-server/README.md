# ChainPay universal MCP server

This server exposes ChainPay as a standard MCP tool provider over JSON-RPC
stdio, so MCP-capable LLM clients can discover and call the same payment tools:

- `get_mandate`
- `get_protocol_config`
- `get_asset`
- `create_mandate`
- `update_mandate`
- `prepare_payment`
- `quote_payment`
- `verify_payment_request`
- `prepare_x402_payment`
- `execute_payment`
- `get_payment`
- `wait_for_payment`
- `pause_mandate`
- `revoke_mandate`

The server accepts only public addresses, payment identifiers, and amounts. It
never accepts seed phrases or private keys. `create_mandate`, `pause_mandate`,
and `revoke_mandate` return transactions that must be reviewed and signed by
the owner wallet. `prepare_payment` returns an agent-signed transaction plan.
`prepare_x402_payment` normalizes an x402 exact challenge into the same
policy-checked flow and can relay a wallet-signed transaction through the Rust
backend. The x402 adapter does not custody keys or operate a hosted facilitator.

`execute_payment` performs SDK preflight first. When a base64 wallet-signed
transaction is supplied and `CHAINPAY_BACKEND_URL` is configured, MCP relays
it to the Rust backend for simulation, submission, finality confirmation, and
status tracking. Without a signed transaction it returns a safe transaction
plan; MCP never receives private keys.

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
endpoint at `/healthz`, and a browser-friendly read-only tool catalog at
`/tools`. The HTTP process is stateless and supports POST JSON-RPC requests plus
GET event streams, so a remote MCP client can use a URL such as:

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
Build command: npm ci && npm --prefix sdk run build && npm --prefix mcp-server run build
Start command: node mcp-server/dist/http.js
Health check: /healthz
```

Set `CHAINPAY_RPC_URL`, `CHAINPAY_PROGRAM_ID`, `CHAINPAY_BACKEND_URL`,
`CHAINPAY_BACKEND_AUTH_TOKEN`, and `CHAINPAY_HTTP_AUTH_TOKEN` in the host's
environment settings. Put HTTPS and authentication in front of both endpoints
before using them for real payment traffic.

Render is also supported through the root [render.yaml](../render.yaml)
Blueprint. In Render, choose **New → Blueprint**, connect this repository, and
provide the `CHAINPAY_RPC_URL` and optional `CHAINPAY_HTTP_AUTH_TOKEN` values
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

The repository includes [mcp.json.example](../mcp.json.example) as a template.
It is not automatically loaded by every client: paste its contents into the
MCP settings for your client. The config location belongs to the client, not
to this repository. For example, Claude Desktop and Cursor each have their own
MCP settings; use the client’s “Add MCP server” UI when available.

After deployment, replace `YOUR-HOST.example.com` with the HTTPS hostname and
keep the `/mcp` suffix. The health check is the same hostname with `/healthz`.
To inspect the deployed tool definitions directly in a browser, open the same
hostname with `/tools`. This endpoint returns the same schemas exposed by
MCP's `tools/list` method and does not execute tools or submit transactions.
