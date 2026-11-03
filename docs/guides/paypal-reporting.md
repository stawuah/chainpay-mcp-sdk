# PayPal reconciliation inbox

The merchant inbox imports Transaction Search evidence into separate reporting tables.
It never marks a task paid, creates entitlement, approves a refund, or restores an
agent spending allowance. A matching reference is not proof of settlement or delivery.

## Configuration and authorization

Set `CHAINPAY_PAYPAL_REPORTING_WORKSPACE` to the exact installation-owned merchant
workspace. Unset disables access. Only an authenticated merchant grant in that
workspace can read, sync, or explain rows. Buyer, agent, and other workspace grants
are refused. This setting is not a PayPal account identifier and must be provisioned
by the installation operator. The existing sandbox-only provider boundary applies.

Transaction Search must be enabled for the installation's PayPal sandbox app. No
provider credentials enter the frontend. The service retains raw provider evidence
in its private database; the inbox and AI receive bounded scalar projections that
exclude payer contact information. Treat retained raw evidence as sensitive data.

## Import and recovery

- `POST /v1/paypal/reporting/sync` reads at most two provider pages. Initial coverage
  starts one day before the first sync; earlier history is not imported.
- The cursor keeps a fixed time window and continuation page through disconnects.
  Subsequent windows overlap by three hours. Provider delays and pagination are not
  evidence that every historical transaction has been observed.
- Missing pagination, empty intermediate pages, invalid row identity, or provider
  errors leave coverage incomplete. A changed page count resets the same window to
  page one while retaining already imported evidence; use **Resume sync**.
- Lease tokens fence expired workers. A page's evidence, observation history, and
  cursor advance commit together. Replays preserve one copy of each observation.
- `GET /v1/paypal/reporting/inbox?after=<cursor>` returns up to 100 rows. History is
  capped at 100 variants per displayed row, with an explicit truncation flag.
- `POST /v1/paypal/reporting/rows/<id>/explain` produces a cited, read-only explanation.
  AI output remains advisory. The provider evidence stays readable if AI is down.

Limits per installation workspace per minute: four syncs, thirty inbox reads, ten
AI explanations. Amounts and signed fees remain exact decimal strings with their
own currency. Net proceeds and balance effects remain unknown unless explicitly
established; the UI never sums across currencies or ambiguous observations.

## Verification

Use a disposable database named `chainpay_paypal_<test-name>` and run:

```sh
PAYPAL_TEST_DATABASE_URL=postgresql://localhost/chainpay_paypal_test cargo test -p chainpay-backend --features paypal paypal::reporting -- --include-ignored
npm --prefix frontend run typecheck
PAYPAL_BROWSER_BASE=http://127.0.0.1:5197 node frontend/test/paypal-reporting.browser.mjs
```

Browser checks require the separate PayPal Vite server configured with the fixture
API origin `http://127.0.0.1:8081`. These tests use local provider/model fixtures;
they do not establish live sandbox acceptance or authorize production rollout.
