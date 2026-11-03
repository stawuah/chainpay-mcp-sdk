# PayPal service lifecycle expansion

Implementation builds on the isolated PayPal v3 stack. It does not alter the Colosseum deployment, Anchor, existing relay configuration or on-chain payment policy. Each installation is owned by its merchant; this is not a marketplace or escrow.

## Build sequence and acceptance

1. Versioned services: summary ($4/document), comparison ($8/pair), requirements assessment ($4/document). Server owns price and handler. Quote binds requirements and input hashes. Comparison delivers one output with evidence from both sources. Invalid evidence fails delivery; uncertain transport remains recoverable. Preserve original service requests and task records.
2. Reusable merchant widget and preflight: hand off to the trusted PayPal workspace; never put buyer/merchant grants in embedded pages. Flag unreadable input before checkout. Selection suggestions cannot set prices or approve payments.
3. Subscriptions and bounded quota: $40/month, ten service units, no rollover/overages. Only verified payment grants quota; ACTIVE does not. Atomic reservation/consumption/restoration and explicit buyer-created delegation. Cancellation retains already-paid allowance until expiry. Cash refunds remain separate merchant approvals.
4. Buyer resolution: accept/challenge individual delivered outputs, retain original revisions, approve rework, approve bounded refunds; no waiver of PayPal rights. Evidence includes actual terms, outputs, acceptance and provider records.
5. Reporting inbox: incremental paginated import, matching and unresolved exceptions; preserve exact fees and distinguish buyer cost from merchant proceeds. AI explains, never establishes payment.
6. Dispute assistant: installation-owned transactions only; retrieve permitted actions/deadlines, draft cited evidence, merchant approves exact submission.
7. Invoicing: alternative funding for an unpaid quote, explicit send/reminder, verified full provider payment before processing. Never fulfill from manually recorded external payment.

Pay with crypto remains disabled unless a real enabled sandbox purchase/refund can be verified. Vault, Payouts and native ACP/UCP are deferred. No mock provider path qualifies as acceptance. Video work follows functional acceptance.

## Service catalog slice

Implemented in `backend/src/paypal/services.rs`, quote/domain/AI routes, isolated frontend and separate SDK/MCP entrypoints. Existing requests without `service_id` keep the original service and retry fingerprint. Requirements are private and not included in shared receipts. Exact source excerpts validate provenance, not model reasoning; users still review conclusions.

Local fixtures establish code behavior only. Actual PayPal credentials, model credentials, provider sandbox transactions and hosted deployment remain release gates. No deployment or financial action is authorized by this document.
