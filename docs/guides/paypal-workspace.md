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
   so PayPal checkout can return; sign out clears this tab’s session and private drafts. It does not revoke the grant; an operator can revoke it through the access-management endpoint.
2. Paste or upload 1–10 text/Markdown documents, or use the labeled sample inputs.
   Samples contain readable supplier terms. Use **Check inputs** before preparing a quote; unreadable sources are rejected before checkout.
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

## Outcome analytics

The separate workspace lazy-loads AG Studio 3.0.0 with three custom widgets:
confirmed buyer cost, work outcomes, and receipt evidence. Exact USD strings are
computed by the server; uncaptured quotes and unconfirmed refunds are excluded.
The view is explicitly limited to the latest 100 authorized tasks. Refresh remounts
Studio while retaining its report layout; its in-memory AI conversation restarts.
The custom Outcome analyst sends only the question to the authenticated server,
which loads fresh scoped evidence. It has no payment tools. The model key stays
server-side. Treat generated explanations as commentary, not financial authority.

A task's Transaction Search button reads up to five pages for its original
30-day window, returning only matching known provider IDs. It preserves existing
payment observations when reporting is delayed, unavailable, or truncated. Enable
Transaction Search on the dedicated sandbox app before acceptance testing.

AG Studio's trial watermark is preserved. Set the optional public
`VITE_CHAINPAY_PAYPAL_STUDIO_LICENSE` build variable only to a legitimately issued
license. Confirm coverage through December 16 before hosting for judges; this code
does not grant a commercial license or prove sponsor eligibility.
