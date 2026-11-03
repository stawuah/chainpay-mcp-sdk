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
