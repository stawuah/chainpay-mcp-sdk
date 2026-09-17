# Connect an agent

Use ChainPay's MCP server to discover payment tools, inspect a spending mandate,
and prepare a payment. **Start with discovery. It needs no wallet or funds.**
MCP (Model Context Protocol) lets an AI client discover and call tools.

This guide describes the fork's implementation. A running endpoint may use an
older revision; discovery alone does not prove payment or provider availability.
For coding agents working on the repository, start with [AGENTS.md](../../AGENTS.md).

## 1. Discover tools locally

Install the repository's workspace packages and build from the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm --prefix mcp-server run build
```

Both packages are private workspace packages. Use the built entry point; there
is no published `npx @chainpay/mcp-server` quickstart.

Send one read-only request:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":"first-read","method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' | node mcp-server/dist/server.js
```

**Expected:** one JSON-RPC response with `result.tools`, including
`get_protocol_config` and `get_mandate`. No RPC account read, wallet signature,
or payment is needed. A missing module means the build or installation failed.

## 2. Add ChainPay to your client

For a client that launches stdio servers, use this configuration. Replace the
absolute path with your checkout path:

```json
{
  "mcpServers": {
    "chainpay": {
      "command": "node",
      "args": ["/absolute/path/to/chainpay/mcp-server/dist/server.js"],
      "env": {
        "CHAINPAY_RPC_URL": "https://api.devnet.solana.com"
      }
    }
  }
}
```

Restart the client connection and ask:

> List ChainPay's tools, then call get_protocol_config with no arguments. Report
> the result or error. Do not prepare, sign, or submit a payment.

**Expected:** the tool catalog, followed by the protocol configuration or an
explicit missing-account/RPC error. Discovery can succeed while Devnet is
unavailable. Confirm the configured program and network before continuing.

For a client that supports remote HTTP servers and custom headers:

```json
{
  "mcpServers": {
    "chainpay": {
      "url": "https://YOUR_MCP_HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SCOPED_CONNECTION_TOKEN"
      }
    }
  }
}
```

Replace both placeholders. Client configuration keys vary; use a client with
support for one of the [implemented protocol versions](#protocol-reference).
For public discovery, omit the `headers` object entirely. A placeholder or
expired token can fail authentication even for an otherwise public read.
The server's `/tools` route also exposes schemas in a browser.

## 3. Authorize private reads

A wallet address identifies an account; it does not authenticate a caller.
Private tools need a verified owner session or a scoped connection token.
A mandate is the owner's on-chain spending permission for one approved agent.

1. The owner signs in through the dashboard's wallet-message challenge. Axum
   issues `POST /v1/auth/challenge?wallet=<public-key>` for an allowed `Origin`.
   The wallet signs the exact returned message; `POST /v1/auth/session` accepts
   `challenge_id` and the base64 `signature`, and returns a one-hour session.
   This login signature does not authorize a payment or token delegation.
2. In the dashboard's agent connection flow, select an owned mandate and the
   required tools. Start with `get_mandate` only. Connection registration is
   `POST /connections` on the MCP HTTP server, using the owner session bearer.
3. Copy the returned connection token into the client's private configuration.
   It is shown once and stored hashed. Never commit or paste it into a prompt.
4. Call `get_mandate` with `{"address":"YOUR_MANDATE_PDA"}`.

**Expected:** the selected mandate is readable. Other mandates, unselected tools,
and owner-management tools are rejected for that connection.

For an integration building its own connection UI, the registration body is:

```json
{
  "agentName": "Read-only assistant",
  "scope": "{\"version\":1,\"mandates\":[\"YOUR_MANDATE_PDA\"],\"tools\":[\"get_mandate\"],\"agents\":{}}"
}
```

`scope` is a JSON **string**. The server derives the owner from the session and
fills `agents` from each mandate's on-chain approved agent. Do not invent agent
bindings. Revoke via `DELETE /connections/<connection-id>` using the owner
session. Reconnect after revocation, a mandate's approved-agent change, or a
legacy `Unscoped` connection.

For stdio private calls, add `CHAINPAY_BACKEND_URL` and `CHAINPAY_CALLER_TOKEN`
to the environment with the actual Axum URL and scoped connection token. Axum
must be configured to resolve that connection. `CHAINPAY_HTTP_AUTH_TOKEN` and
`CHAINPAY_BACKEND_AUTH_TOKEN` do not establish caller identity.

Public tools are `get_protocol_config`, `get_asset`, `get_supported_assets`, and
`verify_payment_request`. An authenticated scoped connection still needs each
requested tool in its permission list. `/connections`, `/inbox`, and
`/agent/chat` require an owner session, not a scoped agent token.

## 4. Prepare a payment only after the owner chooses to

Read the current schemas through `tools/list`; do not guess tool names or fields.
The normal sequence is:

1. Verify the invoice and run `check_payment_requirements`. Ask for missing
   details and stop if policy checks fail.
2. Quote and prepare the exact amount, mint, recipient token account, and mandate.
   MCP amounts are unsigned integer strings in the token's smallest units.
   `"1000000"` means one token only when that mint has six decimals.
3. Select an explicit `signingMode` for `execute_payment`:
   - `human`: returns an unsigned transaction for wallet review; only an
     externally signed `signedTransaction` can be relayed. Its signer must
     match the approved agent. The usual human flow sets agent = owner.
   - `delegated`: sends the unsigned transaction to Axum's authenticated,
     mandate-bound managed signer. It rejects supplied signed transactions.
     This requires provisioned provider infrastructure and an approved mandate.
4. Use `wait_for_payment` with the returned `paymentId`, then `get_payment` with
   `receiptAddress` (or `mandate` and `invoiceHash`) to inspect settlement proof.

Preflight is advisory; the program enforces payment policy. The SDK and MCP
server never take seed phrases or private keys. Owner actions to create,
update, pause, or revoke mandates remain owner-signed.

A timeout is an unknown outcome, not permission to pay again. Inspect the
existing payment ID and receipt before retrying. Do not split a payment to evade
a limit. Stop on an expired, paused, revoked, or incompatible mandate and ask
for a new owner decision. A payment receipt proves settlement; merchant delivery
is separate evidence.

## Custom x402 boundary

ChainPay implements a custom `x402/1.0` receipt-proof flow for paid HTTP resources:
`network` is `solana-devnet`, `payTo` is a **recipient token account**, and proof
contains `{signature, receiptPDA}`. It is not a standard x402 facilitator.

`execute_x402_payment` starts with `resource`, `mandate`, `agent`, and an explicit
`signingMode`. Human mode returns a transaction, then accepts its externally
signed version. Delegated mode uses Axum's managed signer. Once paid, resume
with the existing `paymentId` to retry the original delivery without creating
a new settlement.

Standard x402 v2 exact SVM is recognized from the document shape and rejected
as `x402_unsupported_sponsor` before signing or settlement. Changing a header
name cannot turn it into the custom protocol.

Hosted fetches require exact trusted HTTPS merchant origins in
`CHAINPAY_X402_ALLOWED_ORIGINS`. Development can explicitly enable loopback HTTP
with `CHAINPAY_X402_ALLOW_HTTP=true`. Redirects are blocked. See the
[merchant guide](./merchant-integration.md) for the receiving side.

## Protocol reference

The implementation supports a tested subset, not blanket MCP conformance or
MCP OAuth. The implementation and its tests are the reference for this fork:
[protocol source](../../mcp-server/src/protocol.ts) and
[protocol tests](../../mcp-server/test/protocol.test.mjs).

| Version | Connection behavior |
| --- | --- |
| `2026-07-28` | `server/discover`, `tools/list`, `tools/call`; no initialization handshake |
| `2025-06-18`, `2024-11-05` | Legacy `initialize`, `ping`, `tools/list`, `tools/call` |

Current-version requests put `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` in `params._meta`. Results use
`resultType: "complete"` and server identity under `result._meta`. Discovery
advertises only tools, with `ttlMs` and `cacheScope`.

For HTTP, send `MCP-Protocol-Version` and `Mcp-Method`; `tools/call` additionally
requires `Mcp-Name`. Values must match the body. A mismatch returns `-32020`;
an unsupported version returns `-32022` with `supported` and `requested`.
Current-version GET/DELETE on `/mcp` returns 405. Session and event-resumption
headers are ignored. Legacy GET is only a keepalive comment stream. Resources,
prompts, subscriptions, and multi-round-trip requests are not implemented.
Headerless dashboard requests are a ChainPay compatibility path.
