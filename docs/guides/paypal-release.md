# PayPal v3 implementation and release ledger

Implementation branch: `paypal/10-release-hardening`. Review the stacked PRs in
order; no PR is intended for direct merge to `master`. No existing deployment was
updated. The baseline commit is `4bf3d9fc49c57745662b2cad732e0f49c0beca51`;
this is the code baseline, **not proof of the Colosseum deployed SHA**.

## Built for the PayPal hackathon

| PR | New work | Evidence |
| --- | --- | --- |
| [73](https://github.com/stawuah/chainpay-mcp-sdk/pull/73) | Revised outcome-based product and isolation plan | Reviewable proposal |
| [74](https://github.com/stawuah/chainpay-mcp-sdk/pull/74) | Separate feature-gated Axum executable, config and CI | Disabled-route/config tests |
| [75](https://github.com/stawuah/chainpay-mcp-sdk/pull/75) | Sandbox OAuth, exact Orders/capture/refund, reporting and webhook verification adapter | Local HTTP contract tests |
| [76](https://github.com/stawuah/chainpay-mcp-sdk/pull/76) | Dedicated PostgreSQL state, role-bound grants, immutable operation claims, inbox | Concurrent DB/restart tests |
| [77](https://github.com/stawuah/chainpay-mcp-sdk/pull/77) | Quote approval, checkout/capture, refund approval, recovery and redacted receipts | API/DB end-to-end fixtures |
| [78](https://github.com/stawuah/chainpay-mcp-sdk/pull/78) | Actual model-backed paid document processing, evidence validation and receipt explanation | Controlled model-response tests; live model evaluation pending |
| [79](https://github.com/stawuah/chainpay-mcp-sdk/pull/79) | Separate buyer/merchant frontend, exact receipt, CSV and sharing | Desktop/mobile Chrome fixtures and build |
| [80](https://github.com/stawuah/chainpay-mcp-sdk/pull/80) | Separate SDK PayPal export and stdio MCP entrypoint | SDK/MCP tests; no model payment-approval tools |
| [81](https://github.com/stawuah/chainpay-mcp-sdk/pull/81) | AG Studio custom widgets/read-only analyst, scoped transaction reporting | Scoped totals/auth tests and browser analyst fixture |
| Release-hardening PR | Fair webhook queue, external-change review flags, judge-grant expiry, deployment proposal and this runbook | Additional DB/observation tests and schema validation |

The pre-existing Solana program, mandates, wallet flow, x402 path, cards, core
relay and original frontend remain prior work. PayPal does not fund the agent
card, bridge into Solana, create escrow, or inherit on-chain mandate authority.
Significant PayPal additions are isolated in this stack. Describe the Colosseum
submission and earlier planning explicitly in Devpost rather than claiming the
entire ChainPay product was created here.

## Release gates (not yet passed)

- [ ] Record actual Colosseum deployed commit and resource IDs, plus unchanged
  live-demo smoke evidence. Read-only inspection; do not deploy it.
- [ ] Review/merge the stack only into the dedicated PayPal integration branch;
  pin the release commit and toolchain. Preserve the existing master workflow.
- [ ] Confirm all-source/asset license rights with repository owners, add the
  approved root license, and confirm GitHub About shows it. SDK MIT alone is
  insufficient. No license was invented by this implementation.
- [ ] Provision **new** resources from the reviewed `deploy/paypal/render.yaml`;
  review billed cost/credits and keep them available through December 16.
- [ ] Supply dedicated sandbox app/business/buyer credentials, registered webhook
  ID, new database credentials, fixed frontend/API origins and a dedicated
  OpenRouter key with a budget. Never copy the Colosseum environment.
- [ ] Enable Transaction Search on that app and validate it after propagation.
- [ ] Confirm AG Studio trial/license coverage through December 16. Watermark is
  preserved; do not conceal it or claim the dependency itself grants a license.
- [ ] Run the three real sandbox acceptance paths below and retain evidence.
- [ ] Observe five users and one cold judge; resolve blockers and repeat changed
  acceptance paths. Automated browser fixtures are not user research.
- [ ] Confirm a named operator owns uptime, provider/model spend, grant revocation,
  backups, recovery alerts and replacement credentials through judging.
- [ ] If pursuing APIMatic's prize, actually use the PayPal Context Plugin and
  record the tool/version, guidance applied and resulting commit. It was not
  available in this implementation environment; do not answer “used” yet.
- [ ] Record the public demo video only after implementation acceptance, per Dre.

## Real sandbox acceptance (operator executes after configuration)

Use only sandbox accounts; real-money credentials are rejected. Record timestamps,
release SHA, task IDs, provider order/capture/refund IDs, API outcomes, signed
webhook processing and actual model output privately. Publish redacted evidence.
Never substitute simulator events or the local fixture screenshots for this run.

1. **Delivered work:** buyer opens a fresh quote with readable text, explicitly
   approves its terms, completes PayPal sandbox checkout, confirms capture, runs
   the paid task, and inspects generated claims against exact source excerpts.
   Repeated process calls must not repay or rerun already delivered units.
2. **Partial failure:** use the three labeled samples (one intentionally
   unreadable). Gross USD 12.00; two delivered, one failed. Open the merchant
   profile, review failed-unit evidence, approve USD 4.00 refund. Wait for provider
   confirmation: net USD 8.00. Verify the redacted shared receipt, CSV, reporting
   (allow lag), dashboard totals, and read-only AI explanation agree.
3. **Uncertainty:** interrupt a sandbox operation's response in an isolated test
   environment without dispatching a replacement. Resume the original task and
   verify provider reads/webhooks recover it. Confirm only one original money
   operation exists. An unresolved outcome stays unknown; it is never shown as
   zero or retried as a fresh purchase.

Also reject a changed quote, agent-role checkout/refund, foreign workspace task,
unsigned webhook and unapproved refund. Pause only new purchases and prove status,
receipts, reconciliation and existing-work recovery still function. Then repeat
basic Colosseum smoke checks without deploying it.

## Judge testing instructions template (private Devpost field)

Replace all placeholders before submission; this file intentionally has no secrets.

- Demo URL: `<new PayPal frontend HTTPS URL>/paypal/`.
- Buyer workspace code: `<60-day sandbox workspace grant>`.
- Merchant workspace code: `<separate merchant grant>`; use a separate browser
  profile/tab. Neither code is a PayPal login or authorizes payment on its own.
- PayPal sandbox buyer email/password: `<dedicated personal sandbox account>`.
  If PayPal retains another account session, use a fresh browser profile.
- Select **Use three sample documents**, then **Prepare quote**. Approve the
  USD 12.00 quote, complete sandbox checkout and confirm capture after returning.
- Run the paid task and wait for its actual output. The third sample is
  intentionally unreadable. Inspect the delivered summaries and source excerpts.
- In the merchant profile select that task, **Review failed-unit refund**, then
  explicitly approve the USD 4.00 sandbox refund. Return to the receipt to see
  confirmed USD 8.00 net cost. Review the dashboard and ask its analyst to explain.
- A reporting delay does not invalidate a confirmed capture/refund. Use **Check
  original payment** for uncertainty; do not create a replacement payment.
- Codes remain valid beyond December 16. Sign out only clears the local tab.
  Shared demonstration workspaces contain no sensitive inputs and are visible to
  other holders of that role's code. Operator contact: `<monitored contact>`.

## Tools and AI disclosure

Rust/Axum, PostgreSQL/sqlx, React/Vite/TypeScript, PayPal Orders v2/Payments,
OAuth, signed webhooks and Transaction Search; AG Studio 3.0.0 custom widgets and
custom analyst harness; separate ChainPay SDK and stdio MCP tools. OpenRouter
routes the configured `openai/gpt-5-mini` model for document extraction, receipt
explanation and outcome questions. Verify model availability with the dedicated
key before release. Models have no payment authorization tools. Deterministic
code owns prices, roles, approval digests, refunds, exact arithmetic and recovery.
Coding agents assisted implementation; local fixtures are labeled as such.

APIMatic submission answer currently: **Not yet used; sponsor entry pending actual
plugin use.** Replace only with truthful, linked implementation evidence.

## Operations and known limits

Read `deploy/paypal/README.md` before changing flags. New purchases can be paused
without disabling recovery. Do not turn off the whole service during uncertainty.
Do not restart an operation with a new request ID to “fix” a timeout. Keep the
original task and provider IDs. Unmatched inbox events are retained and rotated;
monitor their age and count. An external refund/reversal blocks new work/refund
proposals and suppresses net-cost claims until audited merchant review.

Analytics includes at most 100 authorized tasks, not lifetime totals. Reporting
reads at most five pages in the task's original 30-day window, not a complete
accounting ledger. External disputes/manual refunds are review cases, not an
implemented autonomous disputes product. Source excerpt validation does not prove
semantic correctness; readers must review model output. No whole-account
reconciliation, PayPal-funded cards, multiparty onboarding or live money is claimed.
AG Studio loads a large separate lazy chunk; checkout does not load it. Monitor
cold dashboard load on the hosted target connection. AI calls are rate-limited,
but a dedicated provider budget is still required. No real sandbox transactions,
model calls, hosted acceptance, source-license approval or video completion are
claimed by this ledger.
