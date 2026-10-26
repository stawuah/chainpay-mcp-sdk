# Agent tools for the isolated PayPal workspace

Build from the PayPal branch; these additions are not an npm release:

```sh
npm ci --ignore-scripts
npm --prefix mcp-server run build
```

Run the separate stdio MCP entrypoint with dedicated configuration:

```sh
CHAINPAY_PAYPAL_ENABLED=true \
CHAINPAY_PAYPAL_API_ORIGIN=https://YOUR-SEPARATE-PAYPAL-API \
CHAINPAY_PAYPAL_PUBLIC_ORIGIN=https://YOUR-SEPARATE-PAYPAL-UI \
CHAINPAY_PAYPAL_AGENT_TOKEN=YOUR-SCOPED-AGENT-GRANT \
node mcp-server/dist/paypal.js
```

Keep the grant in the MCP client's secret environment, never prompt text. Issue
an `agent` role grant for the same workspace/principal as its buyer. A buyer or
merchant grant is refused by the MCP boundary. Existing MCP entrypoints and
Solana tool definitions remain unchanged. This slice provides stdio, not a
publicly hosted HTTP MCP endpoint.

Tools: `paypal_list_services`, `paypal_prepare_task`, `paypal_get_receipt`,
`paypal_run_paid_task`, `paypal_check_payment`, `paypal_propose_refund`,
`paypal_explain_receipt`. There is no capture or refund-approval tool.

Allowance and marketplace tools (need `CHAINPAY_PAYPAL_ALLOWANCES=true` on the
API): `paypal_find_allowance`, `paypal_search_catalog`, `paypal_quote_purchase`,
`paypal_purchase`, `paypal_request_approval`, `paypal_list_approvals`,
`paypal_request_refund`. A buyer creates an allowance in the workspace (caps,
merchants, `agent_pays` or `ask_first`) and vaults a PayPal method there. The
agent only reads the allowance view; the `vault` block and token ids never leave
the server. `paypal_purchase` posts `{request_id, allowance_id, merchant,
items, mode: "agent_pays"}` and the server decides: the result `kind` is
`receipt` (charged) or `refused` (with `reason_code`, for example
`per_purchase_cap`). `paypal_request_approval` is the same call with
`mode: "ask_first"` and answers `approval_requested` (buyer decides at
`review_url`); the server refuses either tool when the allowance's mode is the
other one, so an approval request can never charge. No tool can approve on the
buyer's behalf. An allowance the agent cannot see (paused, revoked, named to
another agent) is a 404, not a refused task. A timed-out purchase is retried
with the same `request_id`; the server returns the same task instead of placing
a second order. `paypal_list_approvals` shows the requests this agent made that
are still waiting; a request the rules fail at approval time comes back
`denied` with `approved_by: "rules"` and the reason code.
`paypal_request_refund` records a reason against the failed units and the
merchant approves the refund in the workspace.

An allowance may also use `mode: "ask_above"` with `ask_above_cents`
(0 < threshold ≤ per-purchase cap): the purchase posts `mode: "ask_above"`,
anything at or under the threshold is charged like `agent_pays`, and anything
over it waits for the buyer exactly like `ask_first` (the SDK/MCP tools send
only `agent_pays`/`ask_first` today, so they refuse an `ask_above` allowance
until they learn the third mode). An optional `categories` list (catalog
merchant kinds: `grocery`, `events`, `booking`, `print`) narrows the merchant
list; an out-of-category purchase is refused with `category_not_allowed`. A
confirmed refund on an allowance purchase gives its own cents back to the
allowance once per PayPal refund ID (partial refunds give back only their
amount). Revoking an allowance also deletes its vault token at PayPal; the
revoke stands even if that call fails, and revoking again retries it.

Prepare with a stable request ID and document text. Return the `review_url` to
the buyer; they approve checkout and capture in the workspace. Then run the
existing paid task and inspect its receipt. A proposal identifies the exact
failed-unit refund, but a merchant must approve it in the workspace. Reconcile
uncertain operations on the original task; never create a replacement to force
another payment. Approval/share capabilities are stripped from agent results.

The separate SDK subpath is usable without importing the Solana client:

```ts
import { PayPalAgentClient } from '@chainpayhq/sdk/paypal';
const client = new PayPalAgentClient({
  enabled: true,
  apiOrigin: process.env.CHAINPAY_PAYPAL_API_ORIGIN!,
  workspaceOrigin: process.env.CHAINPAY_PAYPAL_PUBLIC_ORIGIN!,
  token: process.env.CHAINPAY_PAYPAL_AGENT_TOKEN!,
});
await client.requireAgent();
const quote = await client.quote(crypto.randomUUID(), [
  { name: 'Supplier terms', text: 'Actual source text goes here.' },
]);
console.log(quote.review_url); // Human checkout; no payment was dispatched.
```

SDK and MCP tests use transport fixtures and verify role checks, exact values,
stable request keys and exclusion of approval tools. No test pays PayPal.
