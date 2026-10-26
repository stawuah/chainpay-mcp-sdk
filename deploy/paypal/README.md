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

## Vercel release (the hosted test environment)

PayPal runs as its own Vercel project, next to the Colosseum projects
(`chainpay-relay`, `chainpay-mcp`, `chainpay-web`) and sharing none of their
settings, storage or release group. One project serves both halves from one
origin: the Rust function (`backend/api/paypal.rs`) under `/v1/paypal/*`,
`/healthz` and `/internal/cron/paypal/*`, and the PayPal workspace
(`frontend/paypal.html`) at `/` and `/paypal/*`. `node scripts/stage-vercel.mjs
paypal` builds that upload; the `paypal` job in `deploy-vercel.yml` deploys it
after Release checks pass on `master`.

What changes on Vercel, because a function is frozen once it answers:

- `POST /tasks/:id/process` runs the paid work inside the request (up to the
  300 s function limit) instead of in a background task. If the function is cut
  off, "Run or recover this paid task" resumes after the 180 s unit lease.
- `POST /v1/paypal/webhooks` applies the verified event straight away. Anything
  it cannot resolve yet stays in the inbox for the next pass.
- The `PayPal inbox pass` workflow calls `POST /internal/cron/paypal/events`
  every five minutes in place of the 15-second loop. It only reads from PayPal.

One-time setup:

1. **Database.** In the Vercel project, Storage → add Neon Postgres. In the Neon
   console create a database named `chainpay_paypal_live` (the service refuses
   any other name). Copy its direct (unpooled) connection string with that
   database name in the path into `CHAINPAY_PAYPAL_DATABASE_URL`.
2. **Project.** Vercel → New Project in the ChainPay team, named
   `chainpay-paypal`, no Git link (Actions uploads it). Copy the project ID from
   Settings → General.
3. **Environment variables** (Production), in the `chainpay-paypal` project only:

   | Name | Value |
   | --- | --- |
   | `CHAINPAY_PAYPAL_ENABLED` | `true` |
   | `CHAINPAY_PAYPAL_NEW_PURCHASES` | `false` until the acceptance run |
   | `CHAINPAY_PAYPAL_DATABASE_URL` | Neon URL ending `/chainpay_paypal_live?sslmode=require` |
   | `CHAINPAY_PAYPAL_PUBLIC_ORIGIN` | `https://chainpay-paypal.vercel.app` (the project's own domain) |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | sandbox REST app (mark the secret Sensitive) |
   | `PAYPAL_WEBHOOK_ID` | from step 5 |
   | `CHAINPAY_PAYPAL_AI_KEY` | dedicated OpenRouter key with a spend cap (Sensitive) |
   | `CHAINPAY_PAYPAL_CRON_SECRET` | 32+ random characters (Sensitive) |
   | `CHAINPAY_PAYPAL_SUBSCRIPTIONS`, `CHAINPAY_PAYPAL_SUBSCRIPTION_PLAN` | `false`, or `true` and the `P-…` plan |
   | `CHAINPAY_PAYPAL_ALLOWANCES` | `false` until the allowance acceptance run; gates `POST /allowances` and `POST /purchases` |
   | `VITE_CHAINPAY_PAYPAL` | `true` |
   | `VITE_CHAINPAY_PAYPAL_API_ORIGIN` | same as `CHAINPAY_PAYPAL_PUBLIC_ORIGIN` |

   `VITE_*` values are compiled into public JavaScript. Never put a secret there.
4. **GitHub** (repository settings): variable `PAYPAL_VERCEL_PROJECT_ID` = the
   project ID; variable `PAYPAL_EVENTS_DISPATCH_URL` = the project origin; secret
   `PAYPAL_CRON_SECRET` = the same value as `CHAINPAY_PAYPAL_CRON_SECRET`. The
   existing `VERCEL_TOKEN` secret is reused. Then run Actions → Deploy to Vercel.
5. **Webhook.** In the PayPal sandbox app add
   `https://chainpay-paypal.vercel.app/v1/paypal/webhooks` with the order,
   capture, subscription, sale, vault and dispute events (list below), copy its
   ID into `PAYPAL_WEBHOOK_ID` and redeploy.
6. **Check.** `GET /healthz` answers `{"status":"ready"}` once enabled and the
   database answers. Issue test access from a machine with the same env loaded:
   `cargo run -p chainpay-backend --features paypal --bin chainpay-paypal --
   issue-access <workspace> <principal> buyer` (and `merchant`).

## Proposed Render release

`render.yaml` is an unapplied, separate Blueprint: a new Rust service, static site,
and database. Resource names MUST be new: Render can update existing resources
when names collide. Review the displayed cost and verify dedicated resource IDs
before applying. No existing service should reference this file. Automatic deploys
are off; PR publication does not deploy this stack. See the current
[Blueprint specification](https://render.com/docs/blueprint-spec).

Both feature flags ship off. Disabled backend health deliberately returns 503;
it is not a healthy public demo until configuration is complete. For that reason
the Blueprint sets no `healthCheckPath`; add `/healthz` in the Render dashboard
once the service is enabled, otherwise the first deploy is marked failed.
When enabled, `/healthz` also runs `SELECT 1` and answers 503 if the database
does not. Set explicit
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
`PAYMENT.REFUND.COMPLETED` where the sandbox app exposes them. For allowances
and disputes also register `VAULT.PAYMENT-TOKEN.CREATED`,
`VAULT.PAYMENT-TOKEN.DELETED`, `VAULT.PAYMENT-TOKEN.DELETION-INITIATED`,
`CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED` and
`CUSTOMER.DISPUTE.RESOLVED`. Use the new API's
`/v1/paypal/webhooks` URL, never a Colosseum URL. Simulator callbacks are not
accepted as financial evidence. Verify exact available event names in the app.

### Allowances, vault and disputes

`CHAINPAY_PAYPAL_ALLOWANCES=true` (with new purchases on) enables buyer
allowances and catalog purchases; reads, approvals, fulfilment and dispute
routes stay available when it is off. Vaulting a PayPal wallet needs the
**Vault** feature enabled on the sandbox REST app (Apps & Credentials → the app
→ Features → "Vault"); without it the wallet source fails at setup and the card
source is the fallback. The sandbox test card `4111111111111111` with any future
`YYYY-MM` expiry works for the card source. Check both with
`PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node scripts/paypal-sandbox-check.mjs`:
it prints the setup-token status or error name and whether the Disputes API
answers, and never prints the secret.

To raise a sandbox dispute against a captured purchase: sign in to
<https://www.sandbox.paypal.com> as the sandbox *personal* account that paid
(Developer Dashboard → Sandbox → Accounts → the buyer's email and password),
open Activity, pick the payment, choose "Report a problem" and file "Item not
received". Then on the merchant side run `POST /v1/paypal/disputes/sync` (or
wait for the `CUSTOMER.DISPUTE.CREATED` webhook), preview the evidence pack,
and submit it while the status is `WAITING_FOR_SELLER_RESPONSE`. The pack is
built only from stored records and is submitted once per dispute; PayPal, not
ChainPay, decides the outcome.

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

### Review hardening (26 October 2026)

PayPal deployment now requires successful Release checks and PayPal extension
checks for the current master revision. The PayPal workflow also runs on the
stacked review branches and every master push. Database-backed provider fixtures
run serially because they share one inbox; concurrency remains exercised inside
the explicit concurrency tests.

Cold starts skip unchanged schema DDL using a schema-digest ledger under the
migration advisory lock. A changed schema still needs a coordinated release and
an isolated migration rehearsal. Incoming webhook verification is capped at 300
requests per configured webhook per minute before authenticated provider calls;
trusted-edge ingress protection is still required for a public release.
