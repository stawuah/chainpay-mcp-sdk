# PayPal v3: receipts for agent work

Implementation plan, 24 October 2026. Supersedes the PayPal v2 treasury/payout
proposal for this entry only. The existing Solana product and deployment stay
unchanged. User approval: implement incrementally and publish small PRs; defer
video production until implementation acceptance.

## Product

Small research and operations teams purchase document-processing jobs through
PayPal sandbox. An agent selects a priced service, the buyer approves checkout,
and real AI processing produces per-document results. ChainPay connects the
approved purchase, provider payment observations, delivered work, and approved
refunds in one receipt. A merchant-side assistant explains failed work and
proposes a refund; deterministic code and explicit human approval control money.

Acceptance example: three documents at USD 4.00 each; PayPal captures USD 12.00;
two readable documents produce real results, one visibly unreadable sample
fails; a merchant approves a USD 4.00 refund; the receipt retains the original
charge and shows USD 8.00 net buyer cost. No fabricated provider success or AI
outputs. Test fixtures are labeled and never presented as hosted acceptance.

## Authority and isolation

- PayPal checkout approval and merchant refund approval are separate from
  Solana mandates. No claim of on-chain enforcement for PayPal.
- Keep Axum as the backend. Add an isolated PayPal entrypoint in the existing
  backend crate; it never initializes the Solana relay, its storage, or migrations.
- Dedicated PostgreSQL database, PayPal sandbox app, credentials, webhook,
  frontend deployment, sessions, AI key, and explicit service origins.
- Default-off `CHAINPAY_PAYPAL_ENABLED` and `VITE_CHAINPAY_PAYPAL`; API prefix
  `/v1/paypal`, UI `/paypal`, agent tools `paypal_`. No production URL fallback.
- Refuse live PayPal hosts and redirect-following on authenticated provider
  requests. Missing configuration fails closed. Never put secrets in Vite.
- Separate `paypal/integration` branch. Small dependent PRs target their parent
  branch; independent PRs target integration. Do not merge into production master.
- Source baseline: `4bf3d9fc49c57745662b2cad732e0f49c0beca51`. This is not proof
  of the actual Colosseum deployment revision; record that separately at release.
- Existing `Deploy to Vercel` follows successful master pushes. Do not change
  that workflow, existing Vercel/Convex/Render configuration, or shared data.
- No Anchor upgrades, custody bridge, Lithic funding, escrow, or live payments.
- Payment implementation permission never substitutes for payer approval.

## Contracts

Use USD integer cents internally and exact decimal strings at PayPal boundaries.
Reject malformed amounts; never estimate unknown provider fees.

| Record | Required behavior |
| --- | --- |
| Service offer | Immutable version, seller, unit price, delivery contract |
| Task purchase | Authenticated workspace, input hashes, approved quote, provider IDs |
| Usage event | Unique task/unit, input and output hashes, outcome and evidence |
| Operation | Immutable intent, request key, attempts, unresolved outcome retained |
| Payment observation | Provider ID/status/amount, source, observation time |
| Refund proposal | Failed unit IDs, original capture, exact amount, approval digest |
| Receipt projection | Original charge, confirmed refunds, net buyer cost; fees separate |

Persist intent before provider I/O. Concurrent requests claim one operation.
Same key with changed terms conflicts. Timeout means unknown, not failure; read
and reconcile the original operation before any retry. A refund never silently
replenishes a spending budget. Expired uncertain idempotency windows require
operator investigation, not a replacement payment.

Verify PayPal webhook signatures, persist/deduplicate the event, then return
200. Do not acknowledge invalid signatures or failed durable writes. Reordered
events cannot regress confirmed settlement. Transaction Search may lag three
hours and is supplemental reconciliation, never the checkout success gate.

Separate receipt claims: buyer approved; PayPal reports payment; merchant
reports delivery; buyer accepted; AI explained. A PayPal receipt is not a Solana
PDA or an independently verified cryptographic PayPal proof.

## Incremental PRs

| Order | Deliverable | Acceptance |
| --- | --- | --- |
| 01 | This plan and scope delta | Teammates can review decisions without deployment changes |
| 02 | Isolated Axum configuration/entrypoint | Off by default; sandbox only; no existing storage startup |
| 03 | Provider adapter | OAuth expiry, Orders/capture/refund/read/reporting, bounded I/O |
| 04 | Durable operations and webhook inbox | Duplicate/timeout/restart/reordered-event tests |
| 05 | Workspace identity and scoped routes | Buyer/merchant role separation; no shared token as identity |
| 06 | Checkout and actual processing | Approved quote to real provider observation to real output |
| 07 | Receipt UI and export | Exact money, evidence provenance, private/public separation |
| 08 | Refund proposal, approval, recovery | Model cannot authorize; one refund for selected failed units |
| 09 | MCP/SDK tools | Discovery, quote, status, receipt, refund proposal; no model credentials |
| 10 | AG Studio | Custom outcome/cost widgets and grounded read-only assistant |
| 11 | Hosted acceptance and submission operations | Cold-judge flow, changelog, source/license, uptime runbook |

Split stages further when a smaller independently testable change is ready.
Publish each checked, reviewable PR immediately; don't wait for the whole stack.
PR descriptions must distinguish implementation, fixtures, and hosted evidence.

## Verification

Follow the changed component's checks in AGENTS.md. Backend changes require
workspace formatting and tests; frontend requires tests, build, narrow-width
and keyboard checks; MCP/SDK changes require their suites and type checks.

Required cases: exact amount parsing; changed quote rejection; duplicate command;
cross-workspace access; missing approval; stale approval; concurrent refunds;
provider timeout; interrupted worker; webhook duplicates and reordering; invalid
signature; database outage before acknowledgment; reporting lag; prompt injection;
real model failure; unavailable evidence; feature flags off; no production origin
or database access. Financial/provider integration tests remain sandbox-only.

Three hosted acceptance runs: successful work; failed unit and approved refund;
uncertain operation recovered without a new charge. Record real provider IDs
privately and redact shared artifacts. A health check is not payment evidence.

## Build checkpoints and deferred video

Oct 24–27: plan, isolation, provider contracts, durable approval/operations.
Oct 28–31: actual processing, first full checkout, task receipt.
Nov 1–4: refund recovery, reporting, Studio, five observed user walkthroughs.
Nov 5–8: hosted acceptance, isolation review, cold-judge run, feature freeze.
Video production starts only after implementation acceptance. Keep Nov 9–11 as
the submission buffer; finish the working product first. Internal submission
target: Nov 11 noon PST / Nov 12 03:00 Bangkok. Official deadline: Nov 12 noon
PST / Nov 13 03:00 Bangkok. The earlier “2 PM Pacific” statement was incorrect.
Keep the hosted environment available through Dec 16 Pacific for judging buffer.

Deferred video notes: under three minutes, show purchase → real processing →
partial failure → human-approved refund → final receipt → outcome dashboard.
Target 172 seconds; no unrelated Solana demonstration, music, or unlicensed
third-party assets. Keep honest latency cuts and label the unreadable sample.

## Release gates and open dependencies

- Actual sandbox credentials, accounts and webhook registration are required
  for hosted acceptance. Do not infer access from documentation or fixtures.
- Orders CAPTURE plus refund is the baseline. Multiple partial authorization
  captures can need enablement and are not a dependency.
- AG Studio's 45-day trial begun Oct 24 ends before judging does. Secure coverage
  through Dec 16; avoid depending on an unreleased live-update feature.
- Use persistent paid hosting/database; Render's free database expiry and service
  sleep are unsuitable for unattended judging. Budget and provisioning are separate
  operational actions; do not silently repurpose existing services.
- Verify root license rights before applying a whole-repository MIT license.
  The existing SDK license alone does not license all source and assets.
- Public source, full setup, actual judge credentials in the Devpost private
  testing field, significant-progress changelog and free judge access are required.
- APIMatic answer must describe actual plugin use with evidence; do not claim
  it was used merely because it appears in this plan.
- Prize eligibility is one Grand OR Honorable Mention plus one Sponsor prize,
  not unlimited stacking. Prioritize technical implementation and the end-to-end
  experience over extra partner integrations.

## Source references

- [Official rules](https://paypalaihackathon.devpost.com/rules)
- [FAQ](https://paypalaihackathon.devpost.com/details/faqs)
- [Orders v2](https://developer.paypal.com/api/orders/v2/)
- [Capture refunds](https://developer.paypal.com/api/payments/v2/captures-refund)
- [Webhooks](https://developer.paypal.com/api/webhooks/overview/)
- [Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [Access tokens](https://developer.paypal.com/reference/get-an-access-token/)
- [Reporting specification](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/reporting_transactions_v1.json)
- [AG Studio sponsor requirements](https://paypalaihackathon.devpost.com/details/aggrid)
- [APIMatic sponsor requirements](https://paypalaihackathon.devpost.com/details/apimatic)
- [Render sponsor requirements](https://paypalaihackathon.devpost.com/details/render)

The workspace research plan contains the capability inventory, competitor
comparison, 21 scored candidates, source-age notes and research limitations.
