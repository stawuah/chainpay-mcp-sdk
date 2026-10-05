# Owner webhooks

Get a signed HTTPS POST when one of your payments has a verified receipt.

Owner webhooks **notify; they never authorize**. An event is written only
after the relay saw the transaction finalized and the on-chain receipt matched
the payment. Nothing your receiver answers can change, fail or repeat a
payment.

- **Delivery is at-least-once.** The same event can arrive more than once
  (a timeout after you processed it, a manual redelivery). Dedupe by the
  `webhook-id` header.
- **Delivery is not instant.** A scheduled dispatcher sends due events. On
  the hosted Devnet service that schedule is a GitHub Actions workflow
  (`.github/workflows/owner-webhooks-dispatch.yml`, every 5 minutes, and
  GitHub can run it later than that). Expect minutes, not seconds.
- **There are no failure events.** An unknown outcome is never reported as
  failed. Only `payment.receipt_ready` exists today.

## Add an endpoint

Dashboard → **Settings** → **Webhooks** → **Add endpoint**, or with an owner
session (wallet sign-in; agent connection tokens are refused):

```http
POST /v1/webhooks
Authorization: Bearer <owner session>
Content-Type: application/json

{"url": "https://hooks.example.com/chainpay", "description": "Books"}
```

The response holds `secret` (`whsec_…`) **once**. The relay stores only an
encrypted copy and never shows it again. Lost it? Rotate.

Endpoint rules (checked when you add it, and again before every send):

- `https://` only, port 443 or 1024-65535, no `user:password@`, no `#fragment`.
- The host must resolve only to public internet addresses. Loopback, private,
  link-local, carrier-grade NAT, multicast, documentation ranges and cloud
  metadata addresses (`169.254.169.254`, `fd00:ec2::254`, …) are refused for
  IPv4 and IPv6, including IPv4-mapped IPv6. Names such as `localhost`,
  `*.local` and `*.internal` are refused without a lookup.
- The relay connects to the address it checked, does not follow redirects,
  ignores proxy settings, gives up after 5 s to connect and 10 s in total, and
  reads at most 4 KiB of your response. Return a 2xx quickly and do the work
  afterwards.
- Up to 5 active endpoints per owner wallet.

## Routes

All owner routes need an owner session and only ever see your own endpoints;
another owner's id answers 404.

| Route | Does |
| --- | --- |
| `GET /v1/webhooks` | List your endpoints (never secrets). |
| `POST /v1/webhooks` | Add an endpoint. Returns the secret once. |
| `POST /v1/webhooks/{id}/rotate` | New secret, returned once. The old one keeps signing for 24 hours. |
| `POST /v1/webhooks/{id}/disable` | Stop sending. Queued deliveries become `exhausted`. A request already in flight cannot be recalled. |
| `GET /v1/webhooks/{id}/deliveries?limit=25` | Recent deliveries, newest first. |
| `POST /v1/webhook-deliveries/{id}/redeliver` | Send the same event again (same `webhook-id`, same bytes). |

Owner writes are limited to 20 per minute.

## The event

Values below are illustrative.

```http
POST /chainpay HTTP/1.1
content-type: application/json
webhook-id: evt_5d0c3b6f0f9b2f6e8a1c4d7e9f0a1b2c
webhook-timestamp: 1759651200
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
user-agent: ChainPay-Webhooks/1

{"created_at":"2025-10-05T08:00:00.000Z","data":{"amount":"4500000","cluster":"devnet","decimals":6,"mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","operation_id":"payment_3f…","operation_kind":"payment","receipt_pda":"7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q","receipt_url":"https://chainpay.example/verify/7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q"},"id":"evt_5d0c3b6f0f9b2f6e8a1c4d7e9f0a1b2c","type":"payment.receipt_ready","version":1}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable event id, the same as `webhook-id`. One per receipt, type and version. |
| `type`, `version` | `payment.receipt_ready`, `1`. |
| `created_at` | When the relay recorded the payment as confirmed (UTC). |
| `data.operation_id` | The payment id (`operation_kind: "payment"`) or, for a batch, the transaction id (`"transaction"`, one event per receipt). |
| `data.cluster` | `devnet`. |
| `data.receipt_pda` | The on-chain receipt account. |
| `data.receipt_url` | The public receipt page anyone can verify. |
| `data.mint` | Token mint. |
| `data.amount` | Exact amount in base units, as a **string**. Never parse it into a float. |
| `data.decimals` | Mint decimals, or `null` when the relay could not read them. Never guessed. |

No invoice, recipient, agent or customer data is included. Read the public
receipt if you need more.

## Verify every request

The signature follows the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
construction: HMAC-SHA256 over `webhook-id + "." + webhook-timestamp + "." + raw body`,
keyed with the base64-decoded part of your secret after `whsec_`, base64-encoded.
`webhook-signature` holds one or more space-separated `v1,<signature>` values
(two during a rotation).

Verify against the **raw request bytes**, before any JSON parsing.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export function verifyChainPayWebhook(secret: string, headers: Headers, rawBody: Buffer): string {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) throw new Error("missing webhook headers");
  // Refuse replays: the timestamp is set per attempt.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) throw new Error("stale webhook");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    const candidate = Buffer.from(value, "base64");
    // Constant-time comparison; lengths must match first.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return id;
  }
  throw new Error("bad webhook signature");
}
```

Then dedupe and answer fast:

```ts
const id = verifyChainPayWebhook(process.env.CHAINPAY_WEBHOOK_SECRET!, request.headers, raw);
if (await alreadyProcessed(id)) return new Response(null, { status: 200 });
await markProcessed(id);           // same transaction as your side effect, if you can
queueWork(JSON.parse(raw.toString("utf8")));
return new Response(null, { status: 204 });
```

The relay's own verifier (`backend/src/connectors/inbox.rs`,
`StandardWebhooks::verify`) is the same check and is what the tests use.

## Retries

A 2xx is `delivered`. Anything else (a 3xx, since redirects are not followed;
4xx; 5xx; a timeout; a refused connection) schedules a retry of the **same**
event. After attempt _n_ fails, the next attempt waits:

| After attempt | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wait (±20% jitter) | 1 min | 5 min | 15 min | 1 h | 3 h | 6 h | 10 h |

A `429` or `503` with `Retry-After: <seconds>` waits at least that long (up to
10 h). The dispatcher only runs on its schedule, so real gaps are rounded up
to the next run. After 8 attempts the delivery is `exhausted`; a manual
redelivery starts a fresh 8 attempts for the same event.

States you will see: `pending` (waiting for the dispatcher), `delivering`,
`delivered`, `retry_scheduled` (with `next_attempt_at_ms`) and `exhausted`
(with `last_error`). Errors are short and never include your response body.

## Rotate a secret

`POST /v1/webhooks/{id}/rotate` returns a new secret once. For the next 24
hours every request carries two signatures, one per secret, so you can deploy
the new secret without dropping events. After that only the new one signs.

## How it works (for operators)

- The event row is written in the **same storage transaction** that moves the
  payment (or batch transaction) to `confirmed`, so a crash cannot leave a
  confirmed payment without its event. A reconcile pass in every dispatcher
  run also writes events for confirmed operations from the last 72 hours that
  lack one (for example, payments confirmed before webhooks were enabled).
  Only endpoints that existed when the payment confirmed receive it.
- `POST /internal/cron/webhooks/dispatch` (bearer `CRON_SECRET`) runs one
  bounded pass of about 50 seconds: reconcile, then lease due deliveries with
  a random token, send, record. A lease lasts 60 seconds; a dispatcher that
  dies mid-send leaves its rows to be leased again when the lease ends, so no
  event is lost. Overlapping runs are harmless: a row is leased to one run at
  a time, and only the current lease holder can record an outcome.
- Storage: PostgreSQL migration `0013_owner_webhooks.sql`, or the Convex
  tables `webhook_subscriptions`, `webhook_events` and `webhook_deliveries`.
- Secrets are sealed with AES-256-GCM under `OWNER_WEBHOOKS_SECRET_KEY_<KID>`,
  bound to the endpoint id. Storage never sees a plaintext secret.

Settings are in [configuration](../reference/configuration.md#owner-webhooks).
