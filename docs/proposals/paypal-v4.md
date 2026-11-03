# PayPal v4: allowances, catalog purchases and disputes

Implementation notes, 26 October 2026. Builds on PayPal v3 and leaves the
document-processing service, subscriptions and resolution flows as they are.
The Solana product and its deployment are untouched.

## Product

A buyer sets up an allowance: a named spending cap, funded by a vaulted PayPal
wallet or card, that an agent may spend at a fixed list of sandbox merchants.
The agent buys catalog items against it. In `agent_pays` mode a purchase that
passes the rules is charged at once; in `ask_first` mode the agent only asks
and the buyer approves or denies it from an inbox. Every purchase carries the
rule verdict that allowed or refused it. Merchants fulfil per unit, buyers or
agents ask for refunds on failed units, and merchants pull PayPal disputes for
their captures and submit one evidence pack built only from stored records.

## What is enforced where

- Allowance rules (`allowance-rules-v1`) run in `backend/src/paypal/allowance.rs`
  as a pure function. The order is fixed and the first failing rule names the
  reason code: `allowance_not_active`, `allowance_expired`, `agent_not_allowed`,
  `merchant_not_allowed`, `per_purchase_cap`, `total_cap`, `max_per_day`,
  `cooldown`, `vault_not_ready`. The verdict and every check are stored on the
  task and shown on the receipt.
- The rules run inside the same database transaction that reserves the spend
  (`paypal_allowance_spend`, `reserve` rows) and writes the task, so two agents
  cannot both fit under the cap. A denied `ask_first` request writes a `release`
  row, whether the buyer denied it or the rules failed at approval time (then
  `approval` is `denied` and `approved_by` is `rules`). Refunds never release
  spend. Approve, deny and purchase all lock the allowance row before the task
  row. The charge itself refuses an allowance that is no longer Active or has
  expired.
- An allowance is resolved through the caller's own view everywhere, so an
  agent it does not name, another buyer or a merchant gets a 404 from quote and
  purchase rather than a refused task that would show them the caps.
- `POST /purchases` carries the `mode` the caller expects. The server refuses
  the call when the allowance's mode differs, so an approval request can never
  turn into a charge.
- The vault token is written once by the server and never leaves it. Agent
  and merchant views of an allowance have no `vault` block at all. Card data is
  forwarded to PayPal once and is not stored, fingerprinted or logged.
- Money moves only through `App::charge_purchase`: it claims the order
  Operation under the task lock, creates a vault order with a stored
  credential, observes the response with the existing `observations::order`
  check (same custom_id and amount), and captures only when PayPal answers
  `APPROVED` rather than `COMPLETED`. A transport failure leaves the Operation
  unknown for reconcile; nothing is retried.
- Prices live in `backend/src/paypal/catalog.rs`. A request names item ids and
  quantities; the server resolves names and cents. One unit per piece, each
  with its own price, so a failed unit refunds exactly that piece.
- Disputes are provider observations keyed by capture id. A dispute whose
  disputed transaction is not the task's capture is refused. Evidence is
  submitted at most once per dispute (one Operation, claimed under the row
  lock) and only while PayPal is `WAITING_FOR_SELLER_RESPONSE`. The evidence
  pack digest changes whenever the underlying records change, so a stale
  submission is a conflict, not a resend.

## HTTP additions (all under `/v1/paypal`, bearer session)

| Route | Who | Notes |
| --- | --- | --- |
| `POST /allowances` | buyer | idempotent on `request_id`; `vault_source` `paypal` returns `vault.approval_url`, `card` vaults inline |
| `GET /allowances`, `GET /allowances/{id}` | buyer, agent | agents see only Active ones they may use, never `vault`; merchants get an empty list and a 404 |
| `POST /allowances/{id}/vault` | buyer | finishes a PayPal-wallet vault after the approve redirect; repeat-safe |
| `POST /allowances/{id}/status` | buyer | `Active`, `Paused`, `Revoked`; Revoked is final |
| `GET /catalog?q=` | any | fixed seed, four merchants |
| `POST /purchases/quote` | buyer, agent | lines, cents and the verdict; no write, no PayPal; 404 for an allowance the caller cannot see |
| `POST /purchases` `{…, mode}` | buyer, agent | creates the task, reserves spend, charges or asks; refusals are 200 with `purchase.policy.reason_code`; 422 when `mode` differs from the allowance; 404 for an allowance the caller cannot see |
| `GET /purchases/approvals` | buyer, agent | purchases waiting on this buyer, or the ones this agent asked for |
| `POST /purchases/{id}/approve` `{digest}` | buyer | re-runs the rules, then charges; a failed re-check denies the request (`approved_by: "rules"`) and releases the reserve |
| `POST /purchases/{id}/deny` `{reason}` | buyer | releases the reserve |
| `POST /tasks/{id}/fulfil` | merchant | moves Pending units to delivered or failed |
| `POST /tasks/{id}/refund-request` | buyer, agent | stores the request; the merchant approves through `POST /tasks/{id}/refund` |
| `GET /disputes` | buyer, merchant | buyers receive only their own dispute status projection; merchant records remain private |
| `POST /disputes/sync` | merchant | sync asks PayPal per captured task, newest 100, rate limited |
| `GET /disputes/{id}/evidence`, `POST … {digest}` | merchant | preview the pack; submit it once |

Receipts gain `purchase`, `dispute` and `funding_method: "paypal_vault"` in the
private view. The public view shows only `purchase.merchant`,
`purchase.policy.rule` and `dispute.status`.

## Configuration and webhooks

`CHAINPAY_PAYPAL_ALLOWANCES=true` enables `POST /allowances` and
`POST /purchases`; it defaults off and also needs the new-purchases switch.
Register `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`,
`VAULT.PAYMENT-TOKEN.DELETION-INITIATED`, `CUSTOMER.DISPUTE.CREATED`,
`CUSTOMER.DISPUTE.UPDATED` and `CUSTOMER.DISPUTE.RESOLVED` on the sandbox app.
A deleted vault token pauses its allowance; a dispute event is read back from
PayPal before anything is stored. `scripts/paypal-sandbox-check.mjs` reports
whether the sandbox app can vault a PayPal wallet and read the Disputes API.

## Known limits

- Vaulting a PayPal wallet needs the Vault feature on the sandbox app. The
  card source is the fallback and needs no approval step.
- Day boundaries for `max_per_day` are UTC. Weekday-only catalog items use UTC.
- The evidence pack is text only; PayPal file uploads are not used.
- Dispute sync is bounded to the newest 100 captured tasks in the workspace.

## Review corrections — 26 October 2026

The dashboard threshold mode `ask_above` asks the buyer above `ask_above_cents`;
`categories` restricts catalog merchant kinds. SDK/MCP requests support these fields.
`approval_only: true` on an explicit approval request must never dispatch money, even
when a threshold would ordinarily permit an automatic purchase. Unknown modes fail
closed. Refunds never replenish lifetime allowance caps; they still reduce net cost.
Buyer dispute reads expose only owned task/dispute status fields, never raw provider
records, merchant evidence or submission authority. See the production-readiness
review for remaining external release gates.
