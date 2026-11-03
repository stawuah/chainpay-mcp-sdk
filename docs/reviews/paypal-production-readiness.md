# PayPal production-readiness review — 26 October 2026

This review covers PRs #90–#93 and, separately, the unpublished reporting extension.
The implementation remains PayPal sandbox-only. Software review and passing fixtures
are not authorization to enable live payments or evidence that a provider flow works.

## Binding policy

An allowance is a lifetime spending authorization. A confirmed refund reduces the
buyer's net cost but **does not restore spending authority**. Historical refund
records remain readable and auditable. Failed, uncharged purchase reservations can
be released by the existing recovery/denial rules. Solana mandates and PayPal
allowances are separate: neither funds or authorizes the other.

`ask_above` requires buyer approval above its threshold. An explicit approval-only
request cannot charge even below that threshold. Unknown stored modes fail closed.
A wallet login grants identity, never blanket payment approval.

## Release gates

| Gate | Evidence required before live enablement | Owner |
| --- | --- | --- |
| Product and merchant model | Approved scope change; identify the actual merchant of record and payee for every purchase. Seeded catalog merchant names do not prove multi-merchant onboarding or settlement. No live marketplace until the required platform capabilities are confirmed. | Product / backend owner |
| Provider capabilities | Live business-app approval for the actual wallet vaulting, merchant-initiated charging, disputes and reporting APIs used; recorded consent and revocation behavior. A sandbox card fallback is not evidence of wallet entitlement. | PayPal account owner |
| Agent provisioning | Reviewed owner-to-agent grant issuance, scope, expiry, revocation and audit trail. Current operator-issued grants must not be represented as self-service delegation. | Backend owner |
| Hosted identity | Exercise the wallet bridge from each approved hosted origin; reject wrong origin/wallet, expired sessions, redirects and wallet changes. Verify tokens never enter URLs, browser storage, logs or analytics. | Backend / frontend owners |
| Provider acceptance | Buyer-approved sandbox checkout; capture; exact partial refund; allowance denial and approval; timeout/reconciliation; revoke and vault deletion; signed webhook replay; disputes and reporting where enabled. Retain redacted provider IDs and matching receipts. | QA / account owner |
| Operations | Alert on unknown operations, aged event backlog, failed reconciliation, webhook rejection spikes, provider throttling, database saturation and migration errors. Assign incident/on-call owners and rehearse recovery without issuing a replacement payment. | Operations |
| Data protection | Define retention/deletion for uploaded documents, AI outputs, raw reporting evidence, dispute packs and shares; verify backups and restoration on an isolated copy. Confirm provider/model processing terms and logging redaction. | Product / operations |
| Release and rollback | Exact revision must pass Release checks and PayPal extension checks. Rehearse additive schema upgrades on populated data; retain compatible records on rollback. Disable new purchases first during incidents; preserve reconciliation and evidence access. | Release owner |
| Dependencies and licenses | Resolve or document reachability of remaining advisory hits; validate AG Studio licensing before public production use. The trial watermark is not an approved production license. | Engineering / product |
| Capacity | Exercise concurrent reservations, function deadlines, provider retry limits, database pool limits, bounded uploads and model cost budgets at the planned load. Record measured limits and alarms. | Engineering / operations |

Production readiness remains blocked until these evidence gates are satisfied.
No live credentials, deployments, financial actions or shared database migrations
are part of this review. Sandbox acceptance and merge readiness are separate verdicts.

## Provider references

Use current PayPal documentation when verifying the integration:

- [Webhook verification and retries](https://developer.paypal.com/api/rest/webhooks/)
- [Request IDs and API retries](https://developer.paypal.com/api/rest/requests/)
- [Saving PayPal payment methods](https://developer.paypal.com/api/orders-v2/save-with-purchase/paypal)

Provider idempotency retention is finite and API-specific. Retain the application's
original operation identity and reconcile uncertain results; do not create a fresh
charge or refund simply because a request timed out.

## Dependency review and residual risk

Compatible updates were applied to body-parser, proxy-addr, Zod, crypto-bigint
0.7, ctutils, quinn-proto, rustls, rustls-webpki and webpki-roots. Audit results are
not zero: the workspace production npm tree retains nine advisories (three high,
six moderate) in the legacy Solana dependency tree, including bigint-buffer;
the frontend retains two low advisories through @phala/dcap-qvl / elliptic.
The standalone PayPal SDK entry point does not import the Solana entry point,
but this does not establish safety for every consumer of the combined package.
Do not force an incompatible Solana downgrade to hide these results.

Cargo's lockfile retains crypto-bigint 0.5.5 (RUSTSEC-2026-0387) and rsa 0.9.10
(RUSTSEC-2023-0071). Neither is selected by the reviewed PayPal backend dependency
graph: SQLx uses PostgreSQL with default features disabled. Reassess if SQLx
features or cryptography dependencies change. Production release requires an
explicit reachability decision or a supported dependency replacement for all
remaining applicable advisories.

## Recovery boundary

An uncertain response is not a failed payment. Retry the original request with
its original identity; never issue a replacement purchase to test whether the
first succeeded. Browser recovery controls preserve pending operations during
supported in-app navigation and warn before unloading. They are not durable
recovery across a forced browser close, storage loss or a changed wallet session.
Before production, demonstrate recovery from those cases using persisted server
operation records and redacted provider evidence. Never persist card details or
session tokens in browser storage to implement recovery.
