# ChainPay MCP server

Discover payment tools, inspect mandates, prepare transactions, and read receipts
through stdio or HTTP. **Start with [Connect an agent](../docs/guides/connect-an-agent.md)**
for a read-only first result, client configuration, and scoped authorization.

## Run locally

From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm --prefix mcp-server run build
node mcp-server/dist/server.js
```

The build also builds the local SDK. For HTTP, run
`node mcp-server/dist/http.js` with the environment below. From this component
directory, `./start-http.sh` builds and starts HTTP automatically.

## Host the HTTP service

Deploy the repository root: this package consumes the local SDK workspace.
The root [Dockerfile](../Dockerfile) and [Render blueprint](../render.yaml)
provide deployment entry points.

```text
Build: npm ci --include=dev --ignore-scripts && npm --prefix mcp-server run build
Start: node mcp-server/dist/http.js
Health check: /healthz
```

| Setting | Purpose |
| --- | --- |
| `CHAINPAY_RPC_URL` | Solana RPC; use the intended Devnet endpoint |
| `CHAINPAY_PROGRAM_ID` | Program to read and build against |
| `CHAINPAY_BACKEND_URL` | Axum relay and authentication service |
| `DATABASE_URL` | PostgreSQL for connections, inbox, and activity; required in production |
| `CHAINPAY_ALLOWED_ORIGINS` | Explicit allowed browser origins |
| `CHAINPAY_HTTP_PORT` | Local HTTP port override |
| `CHAINPAY_AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY` | Optional inbox assistant provider |
| `CHAINPAY_X402_ALLOWED_ORIGINS` | Exact trusted HTTPS merchant origins, comma-separated |

Use HTTPS when hosted. Production startup refuses an in-memory fallback if the
database is missing. Tokens are hashed at rest. The assistant invokes the same
caller permission checks as external clients.

Private HTTP calls use the caller's owner-session or scoped-connection bearer
token, which MCP forwards to Axum. Shared service tokens do not authorize an
owner. Stdio private calls use `CHAINPAY_BACKEND_URL` plus
`CHAINPAY_CALLER_TOKEN`. See the [authentication steps](../docs/guides/connect-an-agent.md#3-authorize-private-reads)
and [configuration reference](../docs/reference/configuration.md) in the repository docs.

## Routes

| Route | Access and purpose |
| --- | --- |
| `GET /`, `/docs` | Public documentation preview |
| `GET /healthz` | Public service health |
| `GET /tools` | Public schemas from the tool registry; executes nothing |
| `POST /mcp` | JSON-RPC; discovery/public reads available without a token, private tools authorized per caller |
| `GET`, `POST /connections`; `DELETE /connections/:id` | Owner-session connection management |
| `GET /inbox`, `POST /agent/chat` | Owner-session history and assistant |
| `GET /logo.svg`, `/og-image.png` | Public documentation assets |

The [protocol reference](../docs/guides/connect-an-agent.md#protocol-reference)
describes supported versions, headers, discovery, and transport limitations.
The hosted page generates its tool catalog directly from
[src/tools/definitions.ts](src/tools/definitions.ts).

## Payment boundary

Owner management returns owner-signed transaction plans. `execute_payment` and
new `execute_x402_payment` operations require explicit `human` or `delegated`
signing mode. Human mode prepares or relays externally signed transactions;
delegated mode sends unsigned wires to Axum's mandate-bound provider signer.
MCP never accepts a private key or provider credential.

The x402 adapter supports ChainPay's custom `x402/1.0` receipt proof. Standard v2
is recognized and rejected before signing. See the
[custom x402 boundary](../docs/guides/connect-an-agent.md#custom-x402-boundary).
Code and fixture tests do not prove that a running deployment or signer provider
has accepted the complete flow.

## Verify changes

From the repository root:

```bash
npm run check:mcp
npm --prefix mcp-server run test
```

From this directory, `npm run check:mcp` and `npm run test` are aliases;
`npm run check` delegates to the full workspace check.

[All documentation](../docs/README.md) · [SDK](../sdk/README.md)
