# Merchant service handoff and input checks

The merchant chooser opens a separate trusted PayPal workspace. It sends only
one registered service ID in the URL. Credentials and private sources are entered
in the workspace; the merchant helper makes no API requests. Linking is not payment
approval. Configure the workspace origin yourself, never from buyer-controlled input.

```ts
import { createPayPalServiceLink } from '@chainpayhq/sdk/paypal-widget';
document.querySelector('#services')!.append(
  createPayPalServiceLink('https://your-paypal-workspace.example', 'document-compare-v1')
);
```

This browser entrypoint has no SDK, Node, wallet or credential imports. The helper
rejects unknown service IDs, credentials, paths, query strings, fragments and
non-HTTPS origins except loopback HTTP for development. It opens a new tab with
`noopener noreferrer` and no referrer. The workspace validates the selected ID
against its fetched catalog. Never put private source text or tokens in a link.

Run the standalone example from the repository root, after installing dependencies:

```sh
npm --prefix sdk run build
python3 -m http.server 3403 --bind 127.0.0.1
# Open http://127.0.0.1:3403/demo-merchant/paypal.html
```

The example sets `workspaceOrigin` explicitly to `http://localhost:5197`. Run the
isolated frontend separately (and configure the isolated backend to allow that origin):

```sh
VITE_CHAINPAY_PAYPAL=true VITE_CHAINPAY_PAYPAL_API_ORIGIN=http://127.0.0.1:8081 npm --prefix frontend run dev:paypal -- --host localhost
```

See [workspace setup](paypal-workspace.md) and [provider configuration](../reference/paypal-provider.md)
for the separate backend. The default merchant x402 server is unchanged.

Authenticated buyer and agent grants can POST `/v1/paypal/preflight` with
`{service_id, documents: [{name,text}], requirements?}`. A readable input returns
`ready`, exact decimal-string `unit_price` and `amount`, `outputs`, `currency` and
`issues`. Unreadable sources return `ready:false` with zero-based source indices;
malformed or unsupported requests return 422. The API's existing principal rate
limit applies. No task or provider operation is created.

Quotes and preflight share limits: 1–10 sources, nonblank names of at most 120
UTF-8 bytes and at most 16,000 UTF-8 bytes of text per source. Comparison requires
exactly two sources and yields one $8.00 output. Summary and requirements checks
cost $4.00 per source. Requirements checks require 1–4000 UTF-8 bytes of nonblank
buyer requirements. Every source must have at least 30 Unicode alphanumeric
characters. This deterministic minimum does not prove factual quality, valid OCR,
or model deliverability. The delivery contract still checks generated results.

The workspace checks inputs again when preparing a quote. Direct raw quote calls
remain compatible with old unreadable inputs, but checkout rejects those inputs
before dispatching a new PayPal order. Existing payment observations, receipt
reads, reconciliation and paid-task recovery remain available.

POST `/v1/paypal/recommend-service` accepts only `{objective}` (1–2000 UTF-8 bytes),
using a buyer/agent grant and a separate workspace suggestion rate limit. Suggestions use one nonwaiting slot, acquire global capacity without queuing, and time out after 15 seconds. They leave global capacity available for paid work. The
model receives only the objective and registered catalog descriptions, without
prices or documents. Its output must contain exactly one known `service_id`;
extra fields, invented services and price/approval claims are rejected. An explicit null service returns no-match guidance without inventing a service. The server
supplies the bounded explanation from the catalog. Model outages show an error;
manual selection remains available. Accepting a suggestion changes only the
selected service. Buyers must still prepare the quote and explicitly approve it.

Agent SDK methods `preflight` and `recommendService` expose the same read-only
assistance; no new money tools or approval methods are added. Isolated MCP tools `paypal_preflight` and `paypal_recommend_service` forward the
same requests after checking the agent role and runtime argument shapes. HTTP/body bounds and authentication apply to both routes.

Verification uses local provider/model fixtures, isolated PostgreSQL, SDK tests
and desktop/mobile browser fixtures. These establish request boundaries and UI
behavior; they do not establish live provider acceptance, model quality or any
real transaction. No deployment or provider transaction is needed to run them.
