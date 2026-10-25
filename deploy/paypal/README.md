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

An operator can issue a seven-day scoped access grant from the dedicated service
environment (keep its stdout private):

```sh
cargo run -p chainpay-backend --features paypal --bin chainpay-paypal -- issue-access judge-workspace judge-buyer buyer
```

Issue a separate `merchant` principal for review and an `agent` grant sharing the
buyer principal only when needed for tools. Agent grants cannot approve checkout
or refunds. Rotate judge grants before expiry and keep credentials out of source,
video and logs. App identity never replaces the buyer's PayPal checkout approval.

`POST /v1/paypal/tasks/:id/process` starts real AI processing only after a verified
capture. Repeating it reuses the same task, skips delivered/failed units and can
recover unavailable/crashed processing. It never buys again. `POST .../explain`
returns labeled AI commentary plus the authoritative receipt it used.

Tests: `cargo test --workspace --locked`, plus
`cargo test -p chainpay-backend --features paypal --locked` and
`cargo fmt --all -- --check`. Tests use local fixtures, not PayPal credentials.
