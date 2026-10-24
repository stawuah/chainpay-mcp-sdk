# PayPal task HTTP API

All private routes require an expiring, workspace-scoped bearer grant. The role
comes from storage, never the request body. The API is under `/v1/paypal` in the
isolated Axum entrypoint. JSON request bodies reject unknown fields. Responses
are `no-store`; CORS permits only the configured separate frontend origin.

| Route | Behavior |
| --- | --- |
| `GET /session`, `DELETE /session` | Inspect/revoke current grant |
| `GET /offers` | Versioned document-processing offer, USD 4.00/unit |
| `POST /tasks` | `{request_id, documents: [{name,text}]}`; buyer/agent prepares quote |
| `GET /tasks`, `GET /tasks/:id` | Scoped receipt projections; latest 100 tasks |
| `POST /tasks/:id/checkout` | Buyer explicitly approves `{digest}`; one create operation |
| `POST /tasks/:id/capture` | Buyer confirms `{digest}` after PayPal approval; one capture |
| `POST /tasks/:id/reconcile` | Read original provider resources; never resubmit money |
| `GET /tasks/:id/refund-proposal` | Deterministic failed-unit amount and approval digest |
| `POST /tasks/:id/refund` | Merchant approves `{digest}`; one exact refund |
| `POST`, `DELETE /tasks/:id/share` | Buyer creates/revokes unguessable public receipt token |
| `GET /receipts/:token` | Redacted receipt; no inputs, outputs or approval capabilities |
| `POST /webhooks` | Verify against registered PayPal ID; durably insert before 200 |

The browser return URL is not evidence of payment. Capture first retrieves the
stored PayPal order, checks its original custom task ID and exact USD amount,
and requires the provider's APPROVED state. Delivery requires a matching
COMPLETED capture. Duplicate clicks return original state and do not send again.

Refunds reference the stored capture and resolved failed units. Buyer and agent
grants cannot approve them. The original gross charge remains visible; only a
COMPLETED refund lowers net cost. Reordered older order observations do not erase
a known capture. Raw provider responses never appear in the public projection.

The inbox worker performs provider reads only. Unmatched events remain pending
for correlation with in-flight state; unavailable provider reads remain unresolved.
Read routes, refund recovery and capture of already-approved purchases remain
available when the new-purchase switch is off. Starting a new checkout is refused.

The initial implementation supports one full capture and one failed-unit refund
per task. It does not automatically infer external/manual refunds or disputes.
Reconciliation of an unknown create/refund without a recoverable provider ID
requires a verified matching webhook or operator investigation. There is no
force-new-payment escape hatch.

The HTTP fixture test uses a local fake provider and explicitly labeled work
outcomes, plus a real isolated PostgreSQL database. It proves concurrency and
authorization, not real PayPal acceptance or actual AI delivery.
