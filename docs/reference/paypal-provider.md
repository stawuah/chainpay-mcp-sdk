# PayPal sandbox provider boundary

The optional `paypal` feature adds a provider client to the existing Axum crate.
It is not exposed as an unauthenticated payment route or a model tool. Callers
must persist immutable intent and verify explicit approval before invoking it.
The disabled entrypoint remains disabled until the durable application layer lands.

The API origin is fixed to `https://api-m.sandbox.paypal.com`. Production and
user-supplied origins are not supported. The client has a 5-second connection
timeout, 25-second total timeout, no redirects and a 1 MiB response bound.
Provider IDs and request keys cannot contain URL/header injection characters.

OAuth renewal uses `expires_in`, with 30 seconds of cache safety margin and a
single refresh in flight. A 401 clears the cache but does not replay the request.
All mutations make exactly one HTTP attempt. Timeouts, malformed/oversized
responses, redirects and 5xx return unknown. A non-2xx response is not permission
to create a replacement operation. No raw error response or credential is logged.

USD amounts use integer cents and exact decimal strings. A refund always specifies
an amount; an accidental empty-body full refund is not possible through this API.
Responses remain raw JSON so unknown fields and `seller_receivable_breakdown`
are not discarded. Business code must validate identity, currency, amount and
state before deriving a payment observation or authorizing delivery.

Webhook verification posts signed metadata and the event to PayPal using the
configured registration ID, never a body-supplied webhook ID. Certificate URLs
are restricted to sandbox PayPal certificate paths and never fetched locally.
Missing signature headers are rejected before provider I/O. Only `SUCCESS`
verifies. PayPal's simulated webhook events cannot use postback verification;
use actual sandbox events for hosted acceptance. Durable inbox acknowledgment
belongs to the next application slice, not this client.

Transaction Search is supplementary, paginated and may lag three hours. It must
not gate immediate receipt success or be treated as proof an absent transaction
never occurred.

Contract tests run local HTTP fixtures only. They prove request shape, safe
retry/redirect behavior, expiry handling, exact values and response retention;
they do not prove account entitlement or real sandbox acceptance.

References: [Orders](https://developer.paypal.com/api/orders/v2/),
[Payments](https://developer.paypal.com/api/payments/v2/),
[webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/),
[idempotency](https://developer.paypal.com/api/rest/reference/idempotency/).
