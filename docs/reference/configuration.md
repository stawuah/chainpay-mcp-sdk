# Configuration

**Choose the service you are running.** The [local setup guide](../getting-started/local-development.md)
provides complete commands; this page explains ownership of the settings.

## Shared service addresses

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CHAINPAY_RPC_URL` | SDK, MCP, backend, merchant | Solana Devnet RPC endpoint |
| `CHAINPAY_PROGRAM_ID` | SDK, MCP, backend, merchant | Deployed ChainPay program; must match the chosen network |
| `CHAINPAY_BACKEND_URL` | MCP and integrations | Axum relay and authentication endpoint |
| `DATABASE_URL` | Axum and HTTP MCP | PostgreSQL database; Axum applies the migrations at startup |
| `CHAINPAY_ALLOWED_ORIGINS` | Axum and HTTP MCP | Explicit browser origins, including scheme and port |

Stdio tool discovery needs no database. The HTTP service uses PostgreSQL for
connections and inbox data. Keep the database URL in the server environment.

## Browser configuration

Vite loads `frontend/.env.local`; start from
[the example](../../frontend/.env.example). Restart Vite after editing it.

| Variable | Destination |
| --- | --- |
| `VITE_CHAINPAY_BACKEND_URL` | Axum base URL |
| `VITE_CHAINPAY_RPC_URL` | Solana RPC or the backend's `/rpc` endpoint |
| `VITE_CHAINPAY_MCP_URL` | MCP `/mcp` endpoint |
| `VITE_CHAINPAY_AGENT_URL` | MCP `/agent/chat` endpoint |

All `VITE_*` values are public. Wallet session tokens remain in memory; do not
put tokens, provider credentials, database passwords, or wallet keys in Vite settings.

## Caller authorization

Private HTTP calls carry an owner-session or scoped-connection bearer token.
For stdio private calls, set `CHAINPAY_CALLER_TOKEN` and the real backend URL.
See [connection setup](../guides/connect-an-agent.md#3-authorize-private-reads).

`CHAINPAY_HTTP_AUTH_TOKEN` and `CHAINPAY_BACKEND_AUTH_TOKEN` are service
configuration, not owner or agent identities. Blank settings do not make
private routes public. Server processes read their environment; copying the
[MCP example](../../mcp-server/.env.example) alone does not load it.

## Optional capabilities

- **Chat:** server-side `OPENROUTER_API_KEY` and provider/model settings in the
  [MCP guide](../../mcp-server/README.md). Tool discovery does not need an AI key.
- **Managed signing:** Privy configuration in the [backend guide](../../backend/README.md).
  Configuration alone is not evidence of an accepted delegated payment.
- **Merchant fetches:** exact origins in `CHAINPAY_X402_ALLOWED_ORIGINS`.
  `CHAINPAY_X402_ALLOW_HTTP=true` allows loopback HTTP for development only.
- **Seller statements:** public identity mappings in [trusted sellers](../guides/trusted-sellers.md).
  Statement signing stays on the merchant host.

The deployment template is [render.yaml](../../render.yaml). Deployment and
shared-database migration are operational actions, not README verification.
