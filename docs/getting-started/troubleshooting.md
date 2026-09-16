# Troubleshooting

Find the failing step, make one correction, and repeat that step.

| Symptom | What to do |
| --- | --- |
| `vite` is missing after root `npm ci --ignore-scripts` | Run `npm --prefix frontend ci --ignore-scripts` from the repository root. The frontend is a separate package. |
| SDK import points to missing `dist/index.js` | Run `npm --prefix sdk run build`; for MCP, run `npm --prefix mcp-server run build`. |
| `npm run dev:app` only prints a message | `app/` is a scaffold. Use `npm --prefix frontend run dev`. |
| MCP stdio appears to hang | It is waiting for JSON lines on stdin. Use the [discovery command](local-development.md#2-check-mcp-without-a-database-or-wallet) or connect an MCP client. |
| `DATABASE_URL is required` | Export a development database URL for Axum or HTTP MCP. Copying a `.env` file does not load it into either process. Stdio discovery needs no database. |
| HTTP MCP reports a missing database relation | Start Axum against the same development database first; it applies migrations. Check backend startup errors. |
| Database connection is refused | Confirm PostgreSQL is running and your URL, role, password, and port match it. Use the same explicit TCP URL, including user and password, for Axum and HTTP MCP. |
| Wallet login fails with an origin error | Use the exact browser origin in `CHAINPAY_ALLOWED_ORIGINS` on both services. `localhost` and `127.0.0.1` differ; `*` does not permit wallet login. Restart after configuration changes. |
| A private request returns 401 or 403 | Use a current owner-session or scoped connection bearer token with permission for that mandate and tool. Reconnect expired/revoked sessions. A wallet address or service token does not authorize the caller. |
| Inbox chat cannot reach an AI provider | Configure the provider credential on MCP, then restart it. Tool discovery and direct MCP calls do not require an AI-provider key. |
| Browser still uses hosted services | Set all four `VITE_CHAINPAY_*_URL` values shown in [local setup](local-development.md#4-run-backend-and-http-mcp-locally-optional), then restart Vite. |
| Opening `/rpc` in a browser fails | Send POST JSON-RPC, such as `getSlot`; browser navigation sends GET. |
| Hosted health check times out | Retry after the service wakes; then check its deployment logs or use local services. |
| Protocol config returns `found: false` | Confirm the RPC cluster and program ID. A missing config is not fixed by restarting the UI. Configuration/bootstrap requires a separately authorized chain operation. |
| Merchant refuses to start | Supply the recipient **token account** and allowed agent public key. Check that its mint is enabled on-chain and the RPC is reachable. |
| `verify:devnet` cannot run `spl-token` | Install the SPL Token CLI and make it available on PATH. The verifier uses it for live extension inspection. |
| Cargo fails with `--offline` | Omit `--offline` on the first run so dependencies can download. Check that your Rust version can compile the locked dependencies. |

## Payment status needs investigation

Preserve the exact amount, mint, mandate address, payment ID, receipt address,
and transaction signature. A successful HTTP response or a merchant `402`
response is not settlement proof. Follow
[settlement recovery](../reference/settlement-recovery.md) before deciding
whether to retry an operation.

For a reproducible issue, report the checkout commit, command and working
directory, relevant service versions, and redacted error. Exclude private keys,
database passwords, bearer tokens, and signed login messages.

## Wallet challenge rejected before signing

Wallet login requires the current session-enabled backend deployment and explicit
`CHAINPAY_ALLOWED_ORIGINS` entries on both the backend and MCP services. A wildcard
may let CORS requests through but does **not** authorize wallet login.

For the hosted frontend and the local development/review ports, use:

```text
https://chainpay-frontend.onrender.com,http://localhost:5173,http://127.0.0.1:5173,http://localhost:5189,http://127.0.0.1:5189
```

Apply this value in the services' Render environment configuration and redeploy the
current session-enabled code. The backend also requires the owner-session database
migration described in [backend README](../../backend/README.md). Include any other actual frontend origin
explicitly; never replace the list with `*` to fix sign-in.

Before opening a wallet, verify challenge creation with a public test address:

```bash
curl -i -X POST \
  'https://chainpay-backend.onrender.com/v1/auth/challenge?wallet=11111111111111111111111111111111' \
  -H 'Origin: http://127.0.0.1:5189'
```

Expect HTTP 200 with a challenge message. This check creates a short-lived challenge
only; it does not sign in or submit a financial transaction. HTTP 401/403 means the
service rejected access, not that the user's wallet rejected signing. If even the
hosted frontend origin fails, inspect the deployed revision and origin configuration.
A successful `/healthz` alone does not establish that wallet login works.

Private requests require the actual owner's wallet session or a scoped connection
credential. `CHAINPAY_HTTP_AUTH_TOKEN` is a server-side integration setting, not an
owner-session bypass. Never place it in frontend code or a Vite environment variable.

