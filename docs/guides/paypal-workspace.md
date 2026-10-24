# PayPal sandbox workspace

This is a separate frontend build. It does not load the existing AppShell,
wallet startup, analytics, relay/RPC proxies or production URL defaults.

```sh
# Export only dedicated public configuration, never provider secrets.
VITE_CHAINPAY_PAYPAL=true VITE_CHAINPAY_PAYPAL_API_ORIGIN=http://127.0.0.1:8081 npm --prefix frontend run dev:paypal
```

Open `http://127.0.0.1:5197/paypal/`. The isolated backend's public origin must
match this URL's origin. For deployment use `npm --prefix frontend run build:paypal`
and publish `frontend/dist-paypal`; rewrite `/paypal` and `/paypal/*` to
`/paypal.html`. Never replace the Colosseum frontend's build or deployment.

1. Enter a dedicated buyer grant. Its token is kept in this tab's sessionStorage
   so PayPal checkout can return; sign out revokes the grant and clears it.
2. Paste or upload 1–10 text/Markdown documents, or use the labeled sample inputs.
   The third sample is intentionally unreadable. Nothing precomputes its outputs.
3. Prepare a quote. Explicitly approve its exact USD total and open sandbox
   checkout. Approve with a separate PayPal sandbox buyer account.
4. Return to this same task and explicitly confirm capture. A forged return URL
   cannot establish payment; the backend verifies the stored provider order.
5. Run the paid task. Unavailable work can be recovered without buying again.
   Inspect summaries and source excerpts; delivery is not buyer acceptance.
6. Ask for an AI explanation and inspect the proposed failed-unit refund. Sign
   into the merchant role to explicitly approve it. The original charge remains.
7. Export exact CSV or share a redacted receipt. Public views exclude documents,
   outputs and approval capabilities. Revoke sharing when no longer needed.

Unknown money operations are kept on the original task. Use **Check original
payment**; don't create a new task to work around uncertain settlement. Payment
and AI availability messages reflect real state, not timed demo animations.

Checks: frontend tests and both builds, plus `test:paypal-browser` against the
dedicated dev server. Browser tests use labeled HTTP fixtures and test desktop,
390px width, role-specific approval controls, no production requests and keyboard
focus. They do not prove actual sandbox acceptance or model quality.
