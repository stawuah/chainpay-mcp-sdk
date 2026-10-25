# Isolated PayPal deployment

This entrypoint belongs to the existing Axum backend crate and is compiled only
with `--features paypal`. The existing relay's entrypoint, configuration,
migrations, database and deployment workflows are unchanged.

```sh
cargo run -p chainpay-backend --features paypal --bin chainpay-paypal
```

The initial foundation serves a disabled health response (503), with no payment
routes. Enabling it intentionally fails until the provider/store implementation
lands. Do not deploy this slice as a working demo.

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

Tests: `cargo test --workspace --locked`, plus
`cargo test -p chainpay-backend --features paypal --locked` and
`cargo fmt --all -- --check`. Tests use local fixtures, not PayPal credentials.
