# Isolated PayPal deployment

This entrypoint belongs to the existing Axum backend crate and is compiled only
with `--features paypal`. The existing relay's entrypoint, configuration,
migrations, database and deployment workflows are unchanged.

```sh
cargo run -p chainpay-backend --features paypal --bin chainpay-paypal
```

With the flag off the service returns disabled health (503) and no payment routes.
Enabled startup requires complete dedicated sandbox configuration and an OpenRouter
key, then initializes only the dedicated PayPal schema and webhook recovery worker.
A ready health response is configuration evidence, not real provider acceptance.

Use `.env.example` as a checklist for a **new** environment. Rust reads exported
environment variables, not this file automatically. Never copy an existing relay
environment. `CHAINPAY_PAYPAL_DATABASE_URL` must name a separate database beginning
`chainpay_paypal_`; `DATABASE_URL` is never a fallback. Use a new database and
credentials with no grants on existing databases. Only the PayPal sandbox API
origin is permitted; authenticated HTTP requests never follow redirects.

`CHAINPAY_PAYPAL_ENABLED` and the separate new-purchase switch both default off.
Recovery/read routes must remain available when only new purchases are disabled.
Use a separate HTTPS frontend origin; localhost HTTP is allowed for development.
No existing Vercel/Convex/Render service should be changed for this deployment.

An operator can issue a scoped access grant (seven days by default) from the dedicated service
environment (keep its stdout private):

```sh
cargo run -p chainpay-backend --features paypal --bin chainpay-paypal -- issue-access judge-workspace judge-buyer buyer
```

Issue a separate `merchant` principal for review and an `agent` grant sharing the
buyer principal only when needed for tools. Agent grants cannot approve checkout
or refunds. Choose judge-grant expiry beyond December 16 and keep credentials out of source,
video and logs. App identity never replaces the buyer's PayPal checkout approval.

`POST /v1/paypal/tasks/:id/process` starts real AI processing only after a verified
capture. Repeating it reuses the same task, skips delivered/failed units and can
recover unavailable/crashed processing. It never buys again. `POST .../explain`
returns labeled AI commentary plus the authoritative receipt it used.

Tests: `cargo test --workspace --locked`, plus
`cargo test -p chainpay-backend --features paypal --locked` and
`cargo fmt --all -- --check`. Tests use local fixtures, not PayPal credentials.

## Proposed Render release

`render.yaml` is an unapplied, separate Blueprint: a new Rust service, static site,
and database. Resource names MUST be new: Render can update existing resources
when names collide. Review the displayed cost and verify dedicated resource IDs
before applying. No existing service should reference this file. Automatic deploys
are off; PR publication does not deploy this stack. See the current
[Blueprint specification](https://render.com/docs/blueprint-spec).

Both feature flags ship off. Disabled backend health deliberately returns 503;
it is not a healthy public demo until configuration is complete. Set explicit
HTTPS origins, dedicated sandbox credentials and webhook ID, and a dedicated AI
key with a provider spending cap. Set `CHAINPAY_PAYPAL_ENABLED=true`, redeploy,
and confirm health. Then enable the frontend build flag and rebuild. Enable new
purchases only for the acceptance run after the release owner approves it. Do not
publish a disabled health endpoint as proof of payment acceptance.

The reviewed release should pin its commit and Rust toolchain before hosting.
Keep all resources paid/credited and available through December 16; do not use an
expiring free database. Verify backups/restores against only this new database.
No container or cloud deployment has been executed by this change.

Register actual app webhook events `CHECKOUT.ORDER.APPROVED`,
`CHECKOUT.ORDER.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`,
`PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REVERSED`,
`PAYMENT.CAPTURE.REFUNDED`, and `PAYMENT.REFUND.PENDING` /
`PAYMENT.REFUND.COMPLETED` where the sandbox app exposes them. Use the new API's
`/v1/paypal/webhooks` URL, never a Colosseum URL. Simulator callbacks are not
accepted as financial evidence. Verify exact available event names in the app.

### Judge access and financial exceptions

`issue-access <workspace> <principal> <role> [days]` defaults to seven days and
accepts 1–60 days for explicit judging grants. Issue 60-day grants on release,
expiring after December 16, and put them only in private testing instructions.
Keep buyer and merchant credentials distinct. Sign out clears the local tab;
`DELETE /v1/paypal/session` explicitly revokes a grant globally for operators.
Opening another tab/profile separates role sessions. A shared judge workspace is
acceptable only for nonsensitive demonstration documents: everyone holding its
buyer code can read that principal's tasks, and its merchant code can review them.
Use separate workspaces and grants for private team or user evaluation.

An observed external refund/reversal flags the task for merchant review, suppresses
its net-cost assertion and blocks further work/refund proposals. This is not a full
disputes product. Do not manually alter payment JSON to clear the warning. Review
provider records and add an audited repair path if a real case requires it.
Unmatched webhook events rotate behind unattempted events; malformed observations
do not prevent unrelated tasks from recovering. No recovery worker dispatches money.
