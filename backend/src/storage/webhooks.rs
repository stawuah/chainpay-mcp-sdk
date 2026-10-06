//! Owner webhook outbox (docs/guides/owner-webhooks.md).
//!
//! Three record types, identical rules in every backend:
//!
//! - `webhook_subscriptions`: one owner's HTTPS endpoint. Its signing secrets
//!   are AES-GCM envelopes sealed by Axum before they reach this layer; storage
//!   never sees a plaintext secret.
//! - `webhook_events`: one row per `(receipt_address, event_type, version)`.
//!   The event is written by the same storage call (one transaction) that moves
//!   the payment to `confirmed`, so a crash cannot leave a confirmed payment
//!   without its event. `body` is the exact byte string every attempt signs.
//! - `webhook_deliveries`: one row per event x subscription, fanned out in the
//!   same transaction. A dispatcher claims due rows with a lease token; only
//!   the holder of the current token can record the outcome.
//!
//! Nothing here can create, change or fail a payment.

use super::convex::{decode, encode};
use super::{
    StatusStore, StorageBackend, StorageError, from_i64, payment_from_row, status_name, to_i64,
    transaction_from_row,
};
use crate::status::{PaymentRecord, PaymentStatus, TransactionRecord};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, postgres::PgRow, types::Json};

/// Longest stored error text. Receiver bodies are never stored.
pub const MAX_ERROR_CHARS: usize = 200;
/// Rows a subscription owner can keep, active or disabled.
pub const MAX_SUBSCRIPTION_ROWS_PER_OWNER: usize = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebhookSubscriptionStatus {
    Active,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookSubscription {
    pub subscription_id: String,
    pub owner_wallet: String,
    pub url: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: WebhookSubscriptionStatus,
    /// Sealed secrets, opaque to storage. Never returned by the owner API.
    pub secrets: Value,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookEvent {
    pub event_id: String,
    pub owner_wallet: String,
    pub event_type: String,
    pub version: u32,
    pub receipt_address: String,
    /// Exact JSON bytes sent (and signed) on every attempt.
    pub body: String,
    /// When the payment reached `confirmed`. Only subscriptions that existed
    /// by then receive the event.
    pub occurred_at_ms: u64,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebhookDeliveryState {
    Pending,
    Delivering,
    Delivered,
    RetryScheduled,
    Exhausted,
}

impl WebhookDeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Delivering => "delivering",
            Self::Delivered => "delivered",
            Self::RetryScheduled => "retry_scheduled",
            Self::Exhausted => "exhausted",
        }
    }

    fn parse(value: &str) -> Result<Self, StorageError> {
        Ok(match value {
            "pending" => Self::Pending,
            "delivering" => Self::Delivering,
            "delivered" => Self::Delivered,
            "retry_scheduled" => Self::RetryScheduled,
            "exhausted" => Self::Exhausted,
            _ => {
                return Err(StorageError::InvalidValue {
                    field: "webhook_delivery.state",
                    value: value.into(),
                });
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookDelivery {
    pub delivery_id: String,
    pub event_id: String,
    pub subscription_id: String,
    pub owner_wallet: String,
    pub event_type: String,
    pub receipt_address: String,
    pub state: WebhookDeliveryState,
    pub attempts: u32,
    pub next_attempt_at_ms: u64,
    #[serde(default)]
    pub lease_token: Option<String>,
    #[serde(default)]
    pub lease_expires_at_ms: Option<u64>,
    #[serde(default)]
    pub last_status: Option<u16>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub delivered_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// A delivery this dispatcher now holds the lease for, with what it needs to send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaimedDelivery {
    pub delivery: WebhookDelivery,
    pub event_body: String,
    pub url: String,
    pub secrets: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeliveryOutcome {
    Delivered {
        status: u16,
    },
    Retry {
        status: Option<u16>,
        error: String,
        next_attempt_at_ms: u64,
    },
    Exhausted {
        status: Option<u16>,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum RedeliverResult {
    Scheduled(WebhookDelivery),
    NotFound,
    /// Pending or being sent right now; nothing to schedule.
    InFlight,
    EndpointDisabled,
}

/// `dlv_<event hex>_<subscription hex>`: deterministic, so fan-out is
/// idempotent without hashing in every backend.
pub fn delivery_id(event_id: &str, subscription_id: &str) -> String {
    let tail = |id: &str| id.split_once('_').map_or(id, |(_, rest)| rest).to_owned();
    format!("dlv_{}_{}", tail(event_id), tail(subscription_id))
}

pub fn truncate_error(error: &str) -> String {
    error.chars().take(MAX_ERROR_CHARS).collect()
}

fn new_delivery(event: &WebhookEvent, subscription_id: &str, now: u64) -> WebhookDelivery {
    WebhookDelivery {
        delivery_id: delivery_id(&event.event_id, subscription_id),
        event_id: event.event_id.clone(),
        subscription_id: subscription_id.into(),
        owner_wallet: event.owner_wallet.clone(),
        event_type: event.event_type.clone(),
        receipt_address: event.receipt_address.clone(),
        state: WebhookDeliveryState::Pending,
        attempts: 0,
        next_attempt_at_ms: now,
        lease_token: None,
        lease_expires_at_ms: None,
        last_status: None,
        last_error: None,
        delivered_at_ms: None,
        created_at_ms: now,
        updated_at_ms: now,
    }
}

/// What a claim does with one due row. Shared by Memory and Postgres;
/// `convex/webhooks.ts` mirrors it.
enum ClaimAction {
    Claim,
    Exhaust(&'static str),
}

fn claim_action(delivery: &WebhookDelivery, active: bool, max_attempts: u32) -> ClaimAction {
    if !active {
        ClaimAction::Exhaust("Endpoint disabled before delivery")
    } else if delivery.attempts >= max_attempts {
        ClaimAction::Exhaust("Attempt limit reached; the last attempt's outcome was not recorded")
    } else {
        ClaimAction::Claim
    }
}

fn apply_claim(delivery: &mut WebhookDelivery, token: &str, now: u64, lease_ms: u64) {
    delivery.state = WebhookDeliveryState::Delivering;
    delivery.attempts += 1;
    delivery.lease_token = Some(token.into());
    delivery.lease_expires_at_ms = Some(now + lease_ms);
    // A crashed holder's row becomes due again exactly when its lease ends.
    delivery.next_attempt_at_ms = now + lease_ms;
    delivery.updated_at_ms = now;
}

fn apply_exhaust(delivery: &mut WebhookDelivery, error: &str, now: u64) {
    delivery.state = WebhookDeliveryState::Exhausted;
    delivery.lease_token = None;
    delivery.lease_expires_at_ms = None;
    delivery.last_error = Some(truncate_error(error));
    delivery.updated_at_ms = now;
}

fn apply_outcome(delivery: &mut WebhookDelivery, outcome: &DeliveryOutcome, now: u64) {
    delivery.lease_token = None;
    delivery.lease_expires_at_ms = None;
    delivery.updated_at_ms = now;
    match outcome {
        DeliveryOutcome::Delivered { status } => {
            delivery.state = WebhookDeliveryState::Delivered;
            delivery.last_status = Some(*status);
            delivery.last_error = None;
            delivery.delivered_at_ms = Some(now);
        }
        DeliveryOutcome::Retry {
            status,
            error,
            next_attempt_at_ms,
        } => {
            delivery.state = WebhookDeliveryState::RetryScheduled;
            delivery.last_status = *status;
            delivery.last_error = Some(truncate_error(error));
            delivery.next_attempt_at_ms = *next_attempt_at_ms;
        }
        DeliveryOutcome::Exhausted { status, error } => {
            delivery.state = WebhookDeliveryState::Exhausted;
            delivery.last_status = *status;
            delivery.last_error = Some(truncate_error(error));
        }
    }
}

fn is_due(delivery: &WebhookDelivery, now: u64) -> bool {
    matches!(
        delivery.state,
        WebhookDeliveryState::Pending
            | WebhookDeliveryState::RetryScheduled
            | WebhookDeliveryState::Delivering
    ) && delivery.next_attempt_at_ms <= now
}

fn memory_emit(state: &mut super::MemoryState, event: &WebhookEvent) -> bool {
    let duplicate = state.webhook_events.contains_key(&event.event_id)
        || state.webhook_events.values().any(|old| {
            old.receipt_address == event.receipt_address
                && old.event_type == event.event_type
                && old.version == event.version
        });
    if duplicate {
        return false;
    }
    state
        .webhook_events
        .insert(event.event_id.clone(), event.clone());
    let subscriptions = state
        .webhook_subscriptions
        .values()
        .filter(|s| {
            s.owner_wallet == event.owner_wallet
                && s.status == WebhookSubscriptionStatus::Active
                && s.created_at_ms <= event.occurred_at_ms
        })
        .map(|s| s.subscription_id.clone())
        .collect::<Vec<_>>();
    for subscription in subscriptions {
        let delivery = new_delivery(event, &subscription, event.created_at_ms);
        state
            .webhook_deliveries
            .entry(delivery.delivery_id.clone())
            .or_insert(delivery);
    }
    true
}

async fn pg_emit(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    event: &WebhookEvent,
) -> Result<bool, StorageError> {
    let inserted = sqlx::query(
        r#"INSERT INTO webhook_events (event_id, owner_wallet, event_type, version,
               receipt_address, body, occurred_at_ms, created_at_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING"#,
    )
    .bind(&event.event_id)
    .bind(&event.owner_wallet)
    .bind(&event.event_type)
    .bind(event.version as i32)
    .bind(&event.receipt_address)
    .bind(&event.body)
    .bind(to_i64(Some(event.occurred_at_ms), "occurred_at_ms")?)
    .bind(to_i64(Some(event.created_at_ms), "created_at_ms")?)
    .execute(&mut **tx)
    .await?
    .rows_affected()
        == 1;
    if !inserted {
        return Ok(false);
    }
    let subscriptions: Vec<String> = sqlx::query(
        "SELECT subscription_id FROM webhook_subscriptions WHERE owner_wallet=$1 AND status='active' AND created_at_ms <= $2",
    )
    .bind(&event.owner_wallet)
    .bind(to_i64(Some(event.occurred_at_ms), "occurred_at_ms")?)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| row.get("subscription_id"))
    .collect();
    for subscription in subscriptions {
        pg_insert_delivery(tx, &new_delivery(event, &subscription, event.created_at_ms)).await?;
    }
    Ok(true)
}

async fn pg_insert_delivery(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    d: &WebhookDelivery,
) -> Result<(), StorageError> {
    sqlx::query(
        r#"INSERT INTO webhook_deliveries (delivery_id, event_id, subscription_id, owner_wallet,
               event_type, receipt_address, state, attempts, next_attempt_at_ms,
               created_at_ms, updated_at_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING"#,
    )
    .bind(&d.delivery_id)
    .bind(&d.event_id)
    .bind(&d.subscription_id)
    .bind(&d.owner_wallet)
    .bind(&d.event_type)
    .bind(&d.receipt_address)
    .bind(d.state.as_str())
    .bind(d.attempts as i32)
    .bind(to_i64(Some(d.next_attempt_at_ms), "next_attempt_at_ms")?)
    .bind(to_i64(Some(d.created_at_ms), "created_at_ms")?)
    .bind(to_i64(Some(d.updated_at_ms), "updated_at_ms")?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn pg_update_delivery(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    d: &WebhookDelivery,
) -> Result<(), StorageError> {
    sqlx::query(
        r#"UPDATE webhook_deliveries SET state=$2, attempts=$3, next_attempt_at_ms=$4,
               lease_token=$5, lease_expires_at_ms=$6, last_status=$7, last_error=$8,
               delivered_at_ms=$9, updated_at_ms=$10
           WHERE delivery_id=$1"#,
    )
    .bind(&d.delivery_id)
    .bind(d.state.as_str())
    .bind(d.attempts as i32)
    .bind(to_i64(Some(d.next_attempt_at_ms), "next_attempt_at_ms")?)
    .bind(&d.lease_token)
    .bind(to_i64(d.lease_expires_at_ms, "lease_expires_at_ms")?)
    .bind(d.last_status.map(i32::from))
    .bind(&d.last_error)
    .bind(to_i64(d.delivered_at_ms, "delivered_at_ms")?)
    .bind(to_i64(Some(d.updated_at_ms), "updated_at_ms")?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

const DELIVERY_COLUMNS: &str = "delivery_id, event_id, subscription_id, owner_wallet, event_type, receipt_address, state, attempts, next_attempt_at_ms, lease_token, lease_expires_at_ms, last_status, last_error, delivered_at_ms, created_at_ms, updated_at_ms";
const SUBSCRIPTION_COLUMNS: &str = "subscription_id, owner_wallet, url, description, status, secrets, created_at_ms, updated_at_ms";

fn delivery_from_row(row: &PgRow) -> Result<WebhookDelivery, StorageError> {
    let req = |value: Option<u64>| value.unwrap_or_default();
    Ok(WebhookDelivery {
        delivery_id: row.try_get("delivery_id")?,
        event_id: row.try_get("event_id")?,
        subscription_id: row.try_get("subscription_id")?,
        owner_wallet: row.try_get("owner_wallet")?,
        event_type: row.try_get("event_type")?,
        receipt_address: row.try_get("receipt_address")?,
        state: WebhookDeliveryState::parse(&row.try_get::<String, _>("state")?)?,
        attempts: u32::try_from(row.try_get::<i32, _>("attempts")?).map_err(|_| {
            StorageError::InvalidValue {
                field: "attempts",
                value: "negative".into(),
            }
        })?,
        next_attempt_at_ms: req(from_i64(
            row.try_get("next_attempt_at_ms")?,
            "next_attempt_at_ms",
        )?),
        lease_token: row.try_get("lease_token")?,
        lease_expires_at_ms: from_i64(row.try_get("lease_expires_at_ms")?, "lease_expires_at_ms")?,
        last_status: row
            .try_get::<Option<i32>, _>("last_status")?
            .and_then(|s| u16::try_from(s).ok()),
        last_error: row.try_get("last_error")?,
        delivered_at_ms: from_i64(row.try_get("delivered_at_ms")?, "delivered_at_ms")?,
        created_at_ms: req(from_i64(row.try_get("created_at_ms")?, "created_at_ms")?),
        updated_at_ms: req(from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?),
    })
}

fn subscription_from_row(row: &PgRow) -> Result<WebhookSubscription, StorageError> {
    let status: String = row.try_get("status")?;
    Ok(WebhookSubscription {
        subscription_id: row.try_get("subscription_id")?,
        owner_wallet: row.try_get("owner_wallet")?,
        url: row.try_get("url")?,
        description: row.try_get("description")?,
        status: match status.as_str() {
            "active" => WebhookSubscriptionStatus::Active,
            "disabled" => WebhookSubscriptionStatus::Disabled,
            _ => {
                return Err(StorageError::InvalidValue {
                    field: "webhook_subscription.status",
                    value: status,
                });
            }
        },
        secrets: row.try_get::<Json<Value>, _>("secrets")?.0,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
        updated_at_ms: from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?
            .unwrap_or_default(),
    })
}

fn subscription_status_name(status: WebhookSubscriptionStatus) -> &'static str {
    match status {
        WebhookSubscriptionStatus::Active => "active",
        WebhookSubscriptionStatus::Disabled => "disabled",
    }
}

const PAYMENT_UPSERT: &str = r#"
    INSERT INTO payments (
        payment_id, idempotency_key, mandate, invoice_hash,
        receipt_address, agent, mint, recipient, amount,
        token_program, signing_mode, signature, slot, status,
        error, created_at_ms, updated_at_ms
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        CAST($9 AS NUMERIC), $10, $11, $12, $13, $14,
        $15, $16, $17
    )
    ON CONFLICT (payment_id) DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key,
        mandate = EXCLUDED.mandate,
        invoice_hash = EXCLUDED.invoice_hash,
        receipt_address = EXCLUDED.receipt_address,
        agent = EXCLUDED.agent,
        mint = EXCLUDED.mint,
        recipient = EXCLUDED.recipient,
        amount = EXCLUDED.amount,
        token_program = EXCLUDED.token_program,
        signing_mode = EXCLUDED.signing_mode,
        signature = EXCLUDED.signature,
        slot = EXCLUDED.slot,
        status = EXCLUDED.status,
        error = EXCLUDED.error,
        updated_at_ms = EXCLUDED.updated_at_ms
    WHERE payments.status NOT IN ('confirmed','failed') AND payments.updated_at_ms <= EXCLUDED.updated_at_ms
"#;

const TRANSACTION_UPSERT: &str = r#"
    INSERT INTO transactions (
        transaction_id, idempotency_key, signature, slot,
        status, error, created_at_ms, updated_at_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (transaction_id) DO UPDATE SET
        idempotency_key = EXCLUDED.idempotency_key,
        signature = EXCLUDED.signature,
        slot = EXCLUDED.slot,
        status = EXCLUDED.status,
        error = EXCLUDED.error,
        updated_at_ms = EXCLUDED.updated_at_ms
    WHERE transactions.status NOT IN ('confirmed','failed') AND transactions.updated_at_ms <= EXCLUDED.updated_at_ms
"#;

const CONFIRMED_PAYMENTS_PAGE: &str = r#"
    WITH page AS (
        SELECT updated_at_ms FROM payments
        WHERE status = 'confirmed' AND updated_at_ms >= $1 AND updated_at_ms < $2
        ORDER BY updated_at_ms DESC LIMIT $3
    )
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program, signing_mode,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments
    WHERE status = 'confirmed' AND updated_at_ms < $2
      AND updated_at_ms >= GREATEST($1, (SELECT COALESCE(MIN(updated_at_ms), $2) FROM page))
    ORDER BY updated_at_ms DESC
"#;

const CONFIRMED_TRANSACTIONS_PAGE: &str = r#"
    WITH page AS (
        SELECT updated_at_ms FROM transactions
        WHERE status = 'confirmed' AND updated_at_ms >= $1 AND updated_at_ms < $2
        ORDER BY updated_at_ms DESC LIMIT $3
    )
    SELECT transaction_id, idempotency_key, signature, slot, status, error,
           created_at_ms, updated_at_ms
    FROM transactions
    WHERE status = 'confirmed' AND updated_at_ms < $2
      AND updated_at_ms >= GREATEST($1, (SELECT COALESCE(MIN(updated_at_ms), $2) FROM page))
    ORDER BY updated_at_ms DESC
"#;

/// Newest-first page of `items` whose time is in `[since, before)`, extended
/// through ties at the page boundary so the next page (`before` = the oldest
/// time returned) never skips a row.
fn page_with_ties<T: Clone>(
    mut items: Vec<(u64, T)>,
    since: u64,
    before: u64,
    limit: usize,
) -> Vec<T> {
    items.retain(|(time, _)| *time >= since && *time < before);
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let Some(boundary) = items.get(limit.saturating_sub(1)).map(|(time, _)| *time) else {
        return items.into_iter().map(|(_, item)| item).collect();
    };
    items
        .into_iter()
        .take_while(|(time, _)| *time >= boundary)
        .map(|(_, item)| item)
        .collect()
}

fn remote_bool(value: Value) -> Result<bool, StorageError> {
    value
        .as_bool()
        .ok_or_else(|| StorageError::Remote("invalid storage value".into()))
}

impl StatusStore {
    /// Write a payment and, in the same transaction, any outbox events whose
    /// receipt now reads `confirmed`. Returns how many events were new.
    pub async fn put_payment_with_events(
        &self,
        record: PaymentRecord,
        events: &[WebhookEvent],
    ) -> Result<u32, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let mut args = json!({"record_json": encode(&record)?});
                // Old Convex deployments accept the original shape.
                if !events.is_empty() {
                    args["events_json"] = json!(encode(&events)?);
                }
                let created: Option<u32> = client.call("put_payment", args).await?;
                Ok(created.unwrap_or(0))
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let skip = state.payments.get(&record.payment_id).is_some_and(|old| {
                    matches!(old.status, PaymentStatus::Confirmed | PaymentStatus::Failed)
                        || (old.updated_at_ms > record.updated_at_ms)
                });
                let id = record.payment_id.clone();
                if !skip {
                    state.payments.insert(id.clone(), record);
                }
                let Some(stored) = state.payments.get(&id).cloned() else {
                    return Ok(0);
                };
                let mut created = 0;
                for event in events {
                    if stored.status == PaymentStatus::Confirmed
                        && stored.receipt_address.as_deref() == Some(&event.receipt_address)
                        && memory_emit(&mut state, event)
                    {
                        created += 1;
                    }
                }
                Ok(created)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                sqlx::query(PAYMENT_UPSERT)
                    .bind(&record.payment_id)
                    .bind(&record.idempotency_key)
                    .bind(&record.mandate)
                    .bind(&record.invoice_hash)
                    .bind(&record.receipt_address)
                    .bind(&record.agent)
                    .bind(&record.mint)
                    .bind(&record.recipient)
                    .bind(record.amount.map(|value| value.to_string()))
                    .bind(&record.token_program)
                    .bind(super::signing_mode_name(record.signing_mode))
                    .bind(&record.signature)
                    .bind(to_i64(record.slot, "slot")?)
                    .bind(status_name(record.status))
                    .bind(&record.error)
                    .bind(to_i64(Some(record.created_at_ms), "created_at_ms")?)
                    .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                    .execute(&mut *tx)
                    .await?;
                let mut created = 0;
                if !events.is_empty() {
                    let row = sqlx::query(
                        "SELECT status, receipt_address FROM payments WHERE payment_id=$1 FOR UPDATE",
                    )
                    .bind(&record.payment_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    let confirmed = row.get::<String, _>("status") == "confirmed";
                    let receipt: Option<String> = row.get("receipt_address");
                    for event in events {
                        if confirmed
                            && receipt.as_deref() == Some(&event.receipt_address)
                            && pg_emit(&mut tx, event).await?
                        {
                            created += 1;
                        }
                    }
                }
                tx.commit().await?;
                Ok(created)
            }
        }
    }

    /// Batch transactions: one event per receipt once the transaction reads
    /// `confirmed`, in the same transaction as that write.
    pub async fn put_transaction_with_events(
        &self,
        record: TransactionRecord,
        events: &[WebhookEvent],
    ) -> Result<u32, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let mut args = json!({"record_json": encode(&record)?});
                if !events.is_empty() {
                    args["events_json"] = json!(encode(&events)?);
                }
                let created: Option<u32> = client.call("put_transaction", args).await?;
                Ok(created.unwrap_or(0))
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let skip = state
                    .transactions
                    .get(&record.transaction_id)
                    .is_some_and(|old| {
                        matches!(old.status, PaymentStatus::Confirmed | PaymentStatus::Failed)
                            || (old.updated_at_ms > record.updated_at_ms)
                    });
                let id = record.transaction_id.clone();
                if !skip {
                    state.transactions.insert(id.clone(), record);
                }
                let confirmed = state
                    .transactions
                    .get(&id)
                    .is_some_and(|t| t.status == PaymentStatus::Confirmed);
                let mut created = 0;
                for event in events {
                    if confirmed && memory_emit(&mut state, event) {
                        created += 1;
                    }
                }
                Ok(created)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                sqlx::query(TRANSACTION_UPSERT)
                    .bind(&record.transaction_id)
                    .bind(&record.idempotency_key)
                    .bind(&record.signature)
                    .bind(to_i64(record.slot, "slot")?)
                    .bind(status_name(record.status))
                    .bind(&record.error)
                    .bind(to_i64(Some(record.created_at_ms), "created_at_ms")?)
                    .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                    .execute(&mut *tx)
                    .await?;
                let mut created = 0;
                if !events.is_empty() {
                    let status: String = sqlx::query(
                        "SELECT status FROM transactions WHERE transaction_id=$1 FOR UPDATE",
                    )
                    .bind(&record.transaction_id)
                    .fetch_one(&mut *tx)
                    .await?
                    .get("status");
                    for event in events {
                        if status == "confirmed" && pg_emit(&mut tx, event).await? {
                            created += 1;
                        }
                    }
                }
                tx.commit().await?;
                Ok(created)
            }
        }
    }

    /// Reconcile: write events for receipts already confirmed. Idempotent by
    /// event identity. Returns how many were new.
    pub async fn emit_webhook_events(&self, events: &[WebhookEvent]) -> Result<u32, StorageError> {
        if events.is_empty() {
            return Ok(0);
        }
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call(
                        "emit_webhook_events",
                        json!({"events_json": encode(&events)?}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                Ok(events
                    .iter()
                    .filter(|event| memory_emit(&mut state, event))
                    .count() as u32)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let mut created = 0;
                for event in events {
                    if pg_emit(&mut tx, event).await? {
                        created += 1;
                    }
                }
                tx.commit().await?;
                Ok(created)
            }
        }
    }

    /// Of these event ids, the ones not stored yet.
    pub async fn missing_webhook_events(
        &self,
        event_ids: &[String],
    ) -> Result<Vec<String>, StorageError> {
        if event_ids.is_empty() {
            return Ok(Vec::new());
        }
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call("missing_webhook_events", json!({"event_ids": event_ids}))
                    .await
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                Ok(event_ids
                    .iter()
                    .filter(|id| !state.webhook_events.contains_key(*id))
                    .cloned()
                    .collect())
            }
            StorageBackend::Postgres(pool) => {
                let present: Vec<String> =
                    sqlx::query("SELECT event_id FROM webhook_events WHERE event_id = ANY($1)")
                        .bind(event_ids)
                        .fetch_all(pool)
                        .await?
                        .into_iter()
                        .map(|row| row.get("event_id"))
                        .collect();
                Ok(event_ids
                    .iter()
                    .filter(|id| !present.contains(id))
                    .cloned()
                    .collect())
            }
        }
    }

    pub async fn get_webhook_event(
        &self,
        event_id: &str,
    ) -> Result<Option<WebhookEvent>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let value: Option<Value> = client
                    .call("get_webhook_event", json!({"event_id": event_id}))
                    .await?;
                value.map(from_remote).transpose()
            }
            StorageBackend::Memory(state) => {
                Ok(state.read().await.webhook_events.get(event_id).cloned())
            }
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query("SELECT event_id, owner_wallet, event_type, version, receipt_address, body, occurred_at_ms, created_at_ms FROM webhook_events WHERE event_id=$1")
                    .bind(event_id)
                    .fetch_optional(pool)
                    .await?;
                row.map(|row| {
                    Ok(WebhookEvent {
                        event_id: row.try_get("event_id")?,
                        owner_wallet: row.try_get("owner_wallet")?,
                        event_type: row.try_get("event_type")?,
                        version: row.try_get::<i32, _>("version")? as u32,
                        receipt_address: row.try_get("receipt_address")?,
                        body: row.try_get("body")?,
                        occurred_at_ms: from_i64(row.try_get("occurred_at_ms")?, "occurred_at_ms")?
                            .unwrap_or_default(),
                        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
                            .unwrap_or_default(),
                    })
                })
                .transpose()
            }
        }
    }

    /// Confirmed payments updated in `[since, before)`, newest first. A page
    /// holds at least `limit` rows when that many exist, plus any rows tied
    /// with the oldest one returned.
    pub async fn list_confirmed_payments(
        &self,
        since: u64,
        before: u64,
        limit: usize,
    ) -> Result<Vec<PaymentRecord>, StorageError> {
        let limit = limit.clamp(1, 200);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<String> = client
                    .call(
                        "list_confirmed_payments",
                        json!({"since": since.to_string(), "before": before.to_string(), "limit": limit.to_string()}),
                    )
                    .await?;
                rows.iter().map(|row| decode(row)).collect()
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let items = state
                    .payments
                    .values()
                    .filter(|p| p.status == PaymentStatus::Confirmed)
                    .map(|p| (p.updated_at_ms, p.clone()))
                    .collect();
                Ok(page_with_ties(items, since, before, limit))
            }
            StorageBackend::Postgres(pool) => sqlx::query(CONFIRMED_PAYMENTS_PAGE)
                .bind(to_i64(Some(since), "since")?)
                .bind(to_i64(Some(before.min(i64::MAX as u64)), "before")?)
                .bind(limit as i64)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(payment_from_row)
                .collect(),
        }
    }

    pub async fn list_confirmed_transactions(
        &self,
        since: u64,
        before: u64,
        limit: usize,
    ) -> Result<Vec<TransactionRecord>, StorageError> {
        let limit = limit.clamp(1, 200);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<String> = client
                    .call(
                        "list_confirmed_transactions",
                        json!({"since": since.to_string(), "before": before.to_string(), "limit": limit.to_string()}),
                    )
                    .await?;
                rows.iter().map(|row| decode(row)).collect()
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let items = state
                    .transactions
                    .values()
                    .filter(|t| t.status == PaymentStatus::Confirmed)
                    .map(|t| (t.updated_at_ms, t.clone()))
                    .collect();
                Ok(page_with_ties(items, since, before, limit))
            }
            StorageBackend::Postgres(pool) => sqlx::query(CONFIRMED_TRANSACTIONS_PAGE)
                .bind(to_i64(Some(since), "since")?)
                .bind(to_i64(Some(before.min(i64::MAX as u64)), "before")?)
                .bind(limit as i64)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(transaction_from_row)
                .collect(),
        }
    }

    /// Create a subscription unless the owner already has `max_active` active
    /// ones (or too many rows overall). Returns false when refused.
    pub async fn create_webhook_subscription(
        &self,
        subscription: WebhookSubscription,
        max_active: usize,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => remote_bool(
                client
                    .call(
                        "create_webhook_subscription",
                        json!({"subscription": subscription, "max_active": max_active.to_string(), "max_rows": MAX_SUBSCRIPTION_ROWS_PER_OWNER.to_string()}),
                    )
                    .await?,
            ),
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let owned = state
                    .webhook_subscriptions
                    .values()
                    .filter(|s| s.owner_wallet == subscription.owner_wallet);
                let (active, total) = owned.fold((0, 0), |(a, t), s| {
                    (a + usize::from(s.status == WebhookSubscriptionStatus::Active), t + 1)
                });
                if active >= max_active
                    || total >= MAX_SUBSCRIPTION_ROWS_PER_OWNER
                    || state
                        .webhook_subscriptions
                        .contains_key(&subscription.subscription_id)
                {
                    return Ok(false);
                }
                state
                    .webhook_subscriptions
                    .insert(subscription.subscription_id.clone(), subscription);
                Ok(true)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                // Serialize creations per owner so two requests cannot both pass the cap.
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7413))")
                    .bind(&subscription.owner_wallet)
                    .execute(&mut *tx)
                    .await?;
                let row = sqlx::query("SELECT COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) AS total FROM webhook_subscriptions WHERE owner_wallet=$1")
                    .bind(&subscription.owner_wallet)
                    .fetch_one(&mut *tx)
                    .await?;
                if row.get::<i64, _>("active") as usize >= max_active
                    || row.get::<i64, _>("total") as usize >= MAX_SUBSCRIPTION_ROWS_PER_OWNER
                {
                    return Ok(false);
                }
                let inserted = sqlx::query(&format!("INSERT INTO webhook_subscriptions ({SUBSCRIPTION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING"))
                    .bind(&subscription.subscription_id)
                    .bind(&subscription.owner_wallet)
                    .bind(&subscription.url)
                    .bind(&subscription.description)
                    .bind(subscription_status_name(subscription.status))
                    .bind(Json(&subscription.secrets))
                    .bind(to_i64(Some(subscription.created_at_ms), "created_at_ms")?)
                    .bind(to_i64(Some(subscription.updated_at_ms), "updated_at_ms")?)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
                    == 1;
                tx.commit().await?;
                Ok(inserted)
            }
        }
    }

    pub async fn list_webhook_subscriptions(
        &self,
        owner: &str,
    ) -> Result<Vec<WebhookSubscription>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<Value> = client
                    .call("list_webhook_subscriptions", json!({"owner": owner}))
                    .await?;
                rows.into_iter().map(from_remote).collect()
            }
            StorageBackend::Memory(state) => {
                let mut rows = state
                    .read()
                    .await
                    .webhook_subscriptions
                    .values()
                    .filter(|s| s.owner_wallet == owner)
                    .cloned()
                    .collect::<Vec<_>>();
                rows.sort_by(|a, b| {
                    b.created_at_ms
                        .cmp(&a.created_at_ms)
                        .then_with(|| a.subscription_id.cmp(&b.subscription_id))
                });
                Ok(rows)
            }
            StorageBackend::Postgres(pool) => sqlx::query(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE owner_wallet=$1 ORDER BY created_at_ms DESC, subscription_id"))
                .bind(owner)
                .fetch_all(pool)
                .await?
                .iter()
                .map(subscription_from_row)
                .collect(),
        }
    }

    /// Owner-scoped: another owner's id reads as absent.
    pub async fn get_webhook_subscription(
        &self,
        owner: &str,
        subscription_id: &str,
    ) -> Result<Option<WebhookSubscription>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let row: Option<Value> = client
                    .call(
                        "get_webhook_subscription",
                        json!({"owner": owner, "subscription_id": subscription_id}),
                    )
                    .await?;
                row.map(from_remote).transpose()
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .webhook_subscriptions
                .get(subscription_id)
                .filter(|s| s.owner_wallet == owner)
                .cloned()),
            StorageBackend::Postgres(pool) => sqlx::query(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM webhook_subscriptions WHERE owner_wallet=$1 AND subscription_id=$2"))
                .bind(owner)
                .bind(subscription_id)
                .fetch_optional(pool)
                .await?
                .as_ref()
                .map(subscription_from_row)
                .transpose(),
        }
    }

    /// Disable an endpoint and close out its queued deliveries. A request
    /// already in flight cannot be recalled; its outcome is still recorded.
    pub async fn disable_webhook_subscription(
        &self,
        owner: &str,
        subscription_id: &str,
        now: u64,
    ) -> Result<Option<WebhookSubscription>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let row: Option<Value> = client
                    .call(
                        "disable_webhook_subscription",
                        json!({"owner": owner, "subscription_id": subscription_id, "now": now.to_string()}),
                    )
                    .await?;
                row.map(from_remote).transpose()
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let Some(subscription) = state
                    .webhook_subscriptions
                    .get_mut(subscription_id)
                    .filter(|s| s.owner_wallet == owner)
                else {
                    return Ok(None);
                };
                if subscription.status == WebhookSubscriptionStatus::Active {
                    subscription.status = WebhookSubscriptionStatus::Disabled;
                    subscription.updated_at_ms = now;
                }
                let subscription = subscription.clone();
                for delivery in state.webhook_deliveries.values_mut() {
                    if delivery.subscription_id == subscription_id
                        && matches!(
                            delivery.state,
                            WebhookDeliveryState::Pending | WebhookDeliveryState::RetryScheduled
                        )
                    {
                        apply_exhaust(delivery, "Endpoint disabled before delivery", now);
                    }
                }
                Ok(Some(subscription))
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let row = sqlx::query(&format!("UPDATE webhook_subscriptions SET status='disabled', updated_at_ms=CASE WHEN status='active' THEN $3 ELSE updated_at_ms END WHERE owner_wallet=$1 AND subscription_id=$2 RETURNING {SUBSCRIPTION_COLUMNS}"))
                    .bind(owner)
                    .bind(subscription_id)
                    .bind(to_i64(Some(now), "now")?)
                    .fetch_optional(&mut *tx)
                    .await?;
                let Some(row) = row else {
                    return Ok(None);
                };
                sqlx::query("UPDATE webhook_deliveries SET state='exhausted', last_error=$2, lease_token=NULL, lease_expires_at_ms=NULL, updated_at_ms=$3 WHERE subscription_id=$1 AND state IN ('pending','retry_scheduled')")
                    .bind(subscription_id)
                    .bind("Endpoint disabled before delivery")
                    .bind(to_i64(Some(now), "now")?)
                    .execute(&mut *tx)
                    .await?;
                let subscription = subscription_from_row(&row)?;
                tx.commit().await?;
                Ok(Some(subscription))
            }
        }
    }

    /// Replace the sealed secret set of an active endpoint.
    pub async fn rotate_webhook_secrets(
        &self,
        owner: &str,
        subscription_id: &str,
        secrets: Value,
        now: u64,
    ) -> Result<Option<WebhookSubscription>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let row: Option<Value> = client
                    .call(
                        "rotate_webhook_secrets",
                        json!({"owner": owner, "subscription_id": subscription_id, "secrets": secrets, "now": now.to_string()}),
                    )
                    .await?;
                row.map(from_remote).transpose()
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                Ok(state
                    .webhook_subscriptions
                    .get_mut(subscription_id)
                    .filter(|s| {
                        s.owner_wallet == owner && s.status == WebhookSubscriptionStatus::Active
                    })
                    .map(|s| {
                        s.secrets = secrets;
                        s.updated_at_ms = now;
                        s.clone()
                    }))
            }
            StorageBackend::Postgres(pool) => sqlx::query(&format!("UPDATE webhook_subscriptions SET secrets=$3, updated_at_ms=$4 WHERE owner_wallet=$1 AND subscription_id=$2 AND status='active' RETURNING {SUBSCRIPTION_COLUMNS}"))
                .bind(owner)
                .bind(subscription_id)
                .bind(Json(&secrets))
                .bind(to_i64(Some(now), "now")?)
                .fetch_optional(pool)
                .await?
                .as_ref()
                .map(subscription_from_row)
                .transpose(),
        }
    }

    /// Atomically lease up to `limit` due deliveries to `lease_token`. Rows
    /// another claimer holds (unexpired lease) are never returned; a row whose
    /// lease expired is due again, so a crashed dispatcher loses no event.
    pub async fn claim_webhook_deliveries(
        &self,
        now: u64,
        limit: usize,
        lease_ms: u64,
        lease_token: &str,
        max_attempts: u32,
    ) -> Result<Vec<ClaimedDelivery>, StorageError> {
        let limit = limit.clamp(1, 50);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<Value> = client
                    .call(
                        "claim_webhook_deliveries",
                        json!({"now": now.to_string(), "limit": limit.to_string(), "lease_ms": lease_ms.to_string(), "lease_token": lease_token, "max_attempts": max_attempts.to_string()}),
                    )
                    .await?;
                rows.into_iter().map(from_remote).collect()
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let mut due = state
                    .webhook_deliveries
                    .values()
                    .filter(|d| is_due(d, now))
                    .map(|d| (d.next_attempt_at_ms, d.delivery_id.clone()))
                    .collect::<Vec<_>>();
                due.sort();
                let mut claimed = Vec::new();
                for (_, id) in due.into_iter().take(limit) {
                    let Some(delivery) = state.webhook_deliveries.get(&id).cloned() else {
                        continue;
                    };
                    let subscription = state
                        .webhook_subscriptions
                        .get(&delivery.subscription_id)
                        .cloned();
                    let active = subscription
                        .as_ref()
                        .is_some_and(|s| s.status == WebhookSubscriptionStatus::Active);
                    let body = state
                        .webhook_events
                        .get(&delivery.event_id)
                        .map(|e| e.body.clone());
                    let row = state.webhook_deliveries.get_mut(&id).expect("present");
                    match (
                        claim_action(&delivery, active, max_attempts),
                        subscription,
                        body,
                    ) {
                        (ClaimAction::Claim, Some(subscription), Some(event_body)) => {
                            apply_claim(row, lease_token, now, lease_ms);
                            claimed.push(ClaimedDelivery {
                                delivery: row.clone(),
                                event_body,
                                url: subscription.url,
                                secrets: subscription.secrets,
                            });
                        }
                        (ClaimAction::Exhaust(reason), _, _) => apply_exhaust(row, reason, now),
                        _ => apply_exhaust(row, "Event or endpoint record missing", now),
                    }
                }
                Ok(claimed)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let rows = sqlx::query(&format!(
                    r#"SELECT {cols}, s.status AS subscription_status, s.url, s.secrets, e.body
                       FROM webhook_deliveries d
                       JOIN webhook_subscriptions s ON s.subscription_id = d.subscription_id
                       JOIN webhook_events e ON e.event_id = d.event_id
                       WHERE d.state IN ('pending','retry_scheduled','delivering')
                         AND d.next_attempt_at_ms <= $1
                       ORDER BY d.next_attempt_at_ms, d.delivery_id
                       LIMIT $2
                       FOR UPDATE OF d SKIP LOCKED"#,
                    cols = DELIVERY_COLUMNS
                        .split(", ")
                        .map(|c| format!("d.{c}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
                .bind(to_i64(Some(now), "now")?)
                .bind(limit as i64)
                .fetch_all(&mut *tx)
                .await?;
                let mut claimed = Vec::new();
                for row in rows {
                    let mut delivery = delivery_from_row(&row)?;
                    let active = row.get::<String, _>("subscription_status") == "active";
                    match claim_action(&delivery, active, max_attempts) {
                        ClaimAction::Claim => {
                            apply_claim(&mut delivery, lease_token, now, lease_ms);
                            pg_update_delivery(&mut tx, &delivery).await?;
                            claimed.push(ClaimedDelivery {
                                delivery,
                                event_body: row.get("body"),
                                url: row.get("url"),
                                secrets: row.get::<Json<Value>, _>("secrets").0,
                            });
                        }
                        ClaimAction::Exhaust(reason) => {
                            apply_exhaust(&mut delivery, reason, now);
                            pg_update_delivery(&mut tx, &delivery).await?;
                        }
                    }
                }
                tx.commit().await?;
                Ok(claimed)
            }
        }
    }

    /// Record an attempt's outcome. Only the current lease holder can; a
    /// stale holder (its lease expired and the row was re-claimed) gets false.
    pub async fn complete_webhook_delivery(
        &self,
        delivery_id: &str,
        lease_token: &str,
        outcome: &DeliveryOutcome,
        now: u64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let (kind, status, error, next) = match outcome {
                    DeliveryOutcome::Delivered { status } => {
                        ("delivered", Some(*status), None, None)
                    }
                    DeliveryOutcome::Retry {
                        status,
                        error,
                        next_attempt_at_ms,
                    } => (
                        "retry_scheduled",
                        *status,
                        Some(truncate_error(error)),
                        Some(next_attempt_at_ms.to_string()),
                    ),
                    DeliveryOutcome::Exhausted { status, error } => {
                        ("exhausted", *status, Some(truncate_error(error)), None)
                    }
                };
                remote_bool(
                    client
                        .call(
                            "complete_webhook_delivery",
                            json!({"delivery_id": delivery_id, "lease_token": lease_token, "outcome": kind, "status": status, "error": error, "next_attempt_at": next, "now": now.to_string()}),
                        )
                        .await?,
                )
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let Some(delivery) = state.webhook_deliveries.get_mut(delivery_id).filter(|d| {
                    d.state == WebhookDeliveryState::Delivering
                        && d.lease_token.as_deref() == Some(lease_token)
                }) else {
                    return Ok(false);
                };
                apply_outcome(delivery, outcome, now);
                Ok(true)
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let row = sqlx::query(&format!("SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE delivery_id=$1 AND state='delivering' AND lease_token=$2 FOR UPDATE"))
                    .bind(delivery_id)
                    .bind(lease_token)
                    .fetch_optional(&mut *tx)
                    .await?;
                let Some(row) = row else {
                    return Ok(false);
                };
                let mut delivery = delivery_from_row(&row)?;
                apply_outcome(&mut delivery, outcome, now);
                pg_update_delivery(&mut tx, &delivery).await?;
                tx.commit().await?;
                Ok(true)
            }
        }
    }

    /// Owner-scoped delivery history, newest first.
    pub async fn list_webhook_deliveries(
        &self,
        owner: &str,
        subscription_id: &str,
        limit: usize,
    ) -> Result<Vec<WebhookDelivery>, StorageError> {
        let limit = limit.clamp(1, 100);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<Value> = client
                    .call(
                        "list_webhook_deliveries",
                        json!({"owner": owner, "subscription_id": subscription_id, "limit": limit.to_string()}),
                    )
                    .await?;
                rows.into_iter().map(from_remote).collect()
            }
            StorageBackend::Memory(state) => {
                let mut rows = state
                    .read()
                    .await
                    .webhook_deliveries
                    .values()
                    .filter(|d| d.owner_wallet == owner && d.subscription_id == subscription_id)
                    .cloned()
                    .collect::<Vec<_>>();
                rows.sort_by(|a, b| {
                    b.created_at_ms
                        .cmp(&a.created_at_ms)
                        .then_with(|| b.delivery_id.cmp(&a.delivery_id))
                });
                rows.truncate(limit);
                Ok(rows)
            }
            StorageBackend::Postgres(pool) => sqlx::query(&format!("SELECT {DELIVERY_COLUMNS} FROM webhook_deliveries WHERE owner_wallet=$1 AND subscription_id=$2 ORDER BY created_at_ms DESC, delivery_id DESC LIMIT $3"))
                .bind(owner)
                .bind(subscription_id)
                .bind(limit as i64)
                .fetch_all(pool)
                .await?
                .iter()
                .map(delivery_from_row)
                .collect(),
        }
    }

    /// Schedule one more attempt of the same event (same event id and body).
    pub async fn redeliver_webhook(
        &self,
        owner: &str,
        delivery_id: &str,
        now: u64,
    ) -> Result<RedeliverResult, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let value: Value = client
                    .call(
                        "redeliver_webhook",
                        json!({"owner": owner, "delivery_id": delivery_id, "now": now.to_string()}),
                    )
                    .await?;
                match value["result"].as_str() {
                    Some("scheduled") => Ok(RedeliverResult::Scheduled(from_remote(
                        value["delivery"].clone(),
                    )?)),
                    Some("not_found") => Ok(RedeliverResult::NotFound),
                    Some("in_flight") => Ok(RedeliverResult::InFlight),
                    Some("endpoint_disabled") => Ok(RedeliverResult::EndpointDisabled),
                    _ => Err(StorageError::Remote("invalid storage value".into())),
                }
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let Some(delivery) = state
                    .webhook_deliveries
                    .get(delivery_id)
                    .filter(|d| d.owner_wallet == owner)
                    .cloned()
                else {
                    return Ok(RedeliverResult::NotFound);
                };
                if matches!(
                    delivery.state,
                    WebhookDeliveryState::Pending | WebhookDeliveryState::Delivering
                ) {
                    return Ok(RedeliverResult::InFlight);
                }
                let active = state
                    .webhook_subscriptions
                    .get(&delivery.subscription_id)
                    .is_some_and(|s| s.status == WebhookSubscriptionStatus::Active);
                if !active {
                    return Ok(RedeliverResult::EndpointDisabled);
                }
                let row = state
                    .webhook_deliveries
                    .get_mut(delivery_id)
                    .expect("present");
                apply_redeliver(row, now);
                Ok(RedeliverResult::Scheduled(row.clone()))
            }
            StorageBackend::Postgres(pool) => {
                let mut tx = pool.begin().await?;
                let row = sqlx::query(&format!("SELECT {cols}, s.status AS subscription_status FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.subscription_id=d.subscription_id WHERE d.delivery_id=$1 AND d.owner_wallet=$2 FOR UPDATE OF d",
                    cols = DELIVERY_COLUMNS.split(", ").map(|c| format!("d.{c}")).collect::<Vec<_>>().join(", ")))
                    .bind(delivery_id)
                    .bind(owner)
                    .fetch_optional(&mut *tx)
                    .await?;
                let Some(row) = row else {
                    return Ok(RedeliverResult::NotFound);
                };
                let mut delivery = delivery_from_row(&row)?;
                if matches!(
                    delivery.state,
                    WebhookDeliveryState::Pending | WebhookDeliveryState::Delivering
                ) {
                    return Ok(RedeliverResult::InFlight);
                }
                if row.get::<String, _>("subscription_status") != "active" {
                    return Ok(RedeliverResult::EndpointDisabled);
                }
                apply_redeliver(&mut delivery, now);
                pg_update_delivery(&mut tx, &delivery).await?;
                tx.commit().await?;
                Ok(RedeliverResult::Scheduled(delivery))
            }
        }
    }
}

/// A manual redelivery is a fresh attempt budget for the same event.
fn apply_redeliver(delivery: &mut WebhookDelivery, now: u64) {
    delivery.state = WebhookDeliveryState::Pending;
    delivery.attempts = 0;
    delivery.next_attempt_at_ms = now;
    delivery.lease_token = None;
    delivery.lease_expires_at_ms = None;
    // The new attempt has not been delivered. Keeping the old time would show
    // `delivered_at_ms` next to `pending` or `retry_scheduled`.
    delivery.delivered_at_ms = None;
    delivery.updated_at_ms = now;
}

fn from_remote<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, StorageError> {
    serde_json::from_value(value).map_err(|_| StorageError::Remote("invalid storage value".into()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::status::SigningMode;

    pub(crate) fn subscription(owner: &str, id: &str, created: u64) -> WebhookSubscription {
        WebhookSubscription {
            subscription_id: id.into(),
            owner_wallet: owner.into(),
            url: "https://receiver.example/hook".into(),
            description: None,
            status: WebhookSubscriptionStatus::Active,
            secrets: json!([{"sealed": id}]),
            created_at_ms: created,
            updated_at_ms: created,
        }
    }

    pub(crate) fn event(owner: &str, receipt: &str, occurred: u64) -> WebhookEvent {
        WebhookEvent {
            event_id: format!("evt_{receipt}"),
            owner_wallet: owner.into(),
            event_type: "payment.receipt_ready".into(),
            version: 1,
            receipt_address: receipt.into(),
            body: format!("{{\"id\":\"evt_{receipt}\"}}"),
            occurred_at_ms: occurred,
            created_at_ms: occurred,
        }
    }

    fn payment(id: &str, receipt: &str, status: PaymentStatus, updated: u64) -> PaymentRecord {
        PaymentRecord {
            payment_id: id.into(),
            idempotency_key: format!("key-{id}"),
            mandate: "mandate".into(),
            invoice_hash: "00".repeat(32),
            receipt_address: Some(receipt.into()),
            agent: None,
            mint: Some("mint".into()),
            recipient: None,
            amount: Some(u64::MAX),
            token_program: None,
            signing_mode: SigningMode::Human,
            signature: Some("sig".into()),
            slot: Some(9),
            status,
            error: None,
            created_at_ms: 1,
            updated_at_ms: updated,
        }
    }

    /// One scenario, run against every backend available to this test run.
    pub(crate) async fn outbox_scenario(store: &StatusStore, tag: &str) {
        let owner = format!("owner-{tag}");
        let other = format!("other-{tag}");
        let sub = format!("whk_{tag}a");
        let late = format!("whk_{tag}b");
        let foreign = format!("whk_{tag}c");
        let receipt = format!("rcpt{tag}");
        let pid = format!("pay-{tag}");
        assert!(
            store
                .create_webhook_subscription(subscription(&owner, &sub, 100), 5)
                .await
                .unwrap()
        );
        assert!(
            store
                .create_webhook_subscription(subscription(&other, &foreign, 100), 5)
                .await
                .unwrap()
        );
        let ev = event(&owner, &receipt, 200);
        // Submitted: no event even when one is offered.
        let created = store
            .put_payment_with_events(
                payment(&pid, &receipt, PaymentStatus::Submitted, 150),
                std::slice::from_ref(&ev),
            )
            .await
            .unwrap();
        assert_eq!(created, 0);
        // A subscription created after the payment confirmed never gets it.
        assert!(
            store
                .create_webhook_subscription(subscription(&owner, &late, 300), 5)
                .await
                .unwrap()
        );
        // Confirmed: exactly one event, one delivery per eligible subscription.
        let created = store
            .put_payment_with_events(
                payment(&pid, &receipt, PaymentStatus::Confirmed, 200),
                std::slice::from_ref(&ev),
            )
            .await
            .unwrap();
        assert_eq!(created, 1);
        // Retries of the same transition (and reconcile) never add another.
        for _ in 0..2 {
            assert_eq!(
                store
                    .put_payment_with_events(
                        payment(&pid, &receipt, PaymentStatus::Confirmed, 210),
                        std::slice::from_ref(&ev)
                    )
                    .await
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            store
                .emit_webhook_events(std::slice::from_ref(&ev))
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .missing_webhook_events(&[ev.event_id.clone(), "evt_missing".into()])
                .await
                .unwrap(),
            vec!["evt_missing".to_owned()]
        );
        assert_eq!(
            store
                .get_webhook_event(&ev.event_id)
                .await
                .unwrap()
                .unwrap()
                .body,
            ev.body
        );
        let history = store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].state, WebhookDeliveryState::Pending);
        assert!(
            store
                .list_webhook_deliveries(&owner, &late, 50)
                .await
                .unwrap()
                .is_empty()
        );
        // Tenant isolation at the storage layer.
        assert!(
            store
                .list_webhook_deliveries(&other, &sub, 50)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .get_webhook_subscription(&other, &sub)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .disable_webhook_subscription(&other, &sub, 400)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .rotate_webhook_secrets(&other, &sub, json!([]), 400)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .redeliver_webhook(&other, &history[0].delivery_id, 400)
                .await
                .unwrap(),
            RedeliverResult::NotFound
        );
        // Two claimers: the second gets nothing while the lease holds.
        let first = store
            .claim_webhook_deliveries(1_000, 50, 60_000, "lease-a", 8)
            .await
            .unwrap();
        let first: Vec<_> = first
            .into_iter()
            .filter(|c| c.delivery.owner_wallet == owner)
            .collect();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].event_body, ev.body);
        assert_eq!(first[0].delivery.attempts, 1);
        let second = store
            .claim_webhook_deliveries(1_001, 50, 60_000, "lease-b", 8)
            .await
            .unwrap();
        assert!(second.iter().all(|c| c.delivery.owner_wallet != owner));
        assert_eq!(
            store
                .redeliver_webhook(&owner, &history[0].delivery_id, 1_002)
                .await
                .unwrap(),
            RedeliverResult::InFlight
        );
        // Holder crashes; after the lease the row is due again, same event.
        let again = store
            .claim_webhook_deliveries(61_001, 50, 60_000, "lease-c", 8)
            .await
            .unwrap();
        let again: Vec<_> = again
            .into_iter()
            .filter(|c| c.delivery.owner_wallet == owner)
            .collect();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].delivery.event_id, ev.event_id);
        assert_eq!(again[0].delivery.attempts, 2);
        // The crashed holder's late result is refused.
        let id = again[0].delivery.delivery_id.clone();
        assert!(
            !store
                .complete_webhook_delivery(
                    &id,
                    "lease-a",
                    &DeliveryOutcome::Delivered { status: 200 },
                    61_002
                )
                .await
                .unwrap()
        );
        let retry = DeliveryOutcome::Retry {
            status: Some(500),
            error: "x".repeat(500),
            next_attempt_at_ms: 90_000,
        };
        assert!(
            store
                .complete_webhook_delivery(&id, "lease-c", &retry, 61_003)
                .await
                .unwrap()
        );
        let row = &store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap()[0];
        assert_eq!(row.state, WebhookDeliveryState::RetryScheduled);
        assert_eq!(row.last_status, Some(500));
        assert_eq!(
            row.last_error.as_ref().unwrap().chars().count(),
            MAX_ERROR_CHARS
        );
        // Not due before its time.
        assert!(
            store
                .claim_webhook_deliveries(89_999, 50, 60_000, "lease-d", 8)
                .await
                .unwrap()
                .iter()
                .all(|c| c.delivery.delivery_id != id)
        );
        let claimed = store
            .claim_webhook_deliveries(90_000, 50, 60_000, "lease-e", 8)
            .await
            .unwrap();
        assert!(claimed.iter().any(|c| c.delivery.delivery_id == id));
        assert!(
            store
                .complete_webhook_delivery(
                    &id,
                    "lease-e",
                    &DeliveryOutcome::Delivered { status: 204 },
                    90_001
                )
                .await
                .unwrap()
        );
        let row = &store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap()[0];
        assert_eq!(row.state, WebhookDeliveryState::Delivered);
        assert_eq!(row.delivered_at_ms, Some(90_001));
        // Manual redelivery: same delivery row and event, fresh attempt budget.
        let RedeliverResult::Scheduled(scheduled) =
            store.redeliver_webhook(&owner, &id, 95_000).await.unwrap()
        else {
            panic!("not scheduled")
        };
        assert_eq!(
            (
                scheduled.event_id.as_str(),
                scheduled.attempts,
                scheduled.state
            ),
            (ev.event_id.as_str(), 0, WebhookDeliveryState::Pending)
        );
        assert_eq!(scheduled.delivered_at_ms, None);
        let row = &store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap()[0];
        assert_eq!(row.delivered_at_ms, None);
        // Attempt cap: a lease that expires at the cap becomes exhausted.
        let claimed = store
            .claim_webhook_deliveries(95_000, 50, 1_000, "lease-f", 1)
            .await
            .unwrap();
        assert!(claimed.iter().any(|c| c.delivery.delivery_id == id));
        assert!(
            store
                .claim_webhook_deliveries(96_000, 50, 1_000, "lease-g", 1)
                .await
                .unwrap()
                .iter()
                .all(|c| c.delivery.delivery_id != id)
        );
        let row = &store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap()[0];
        assert_eq!(row.state, WebhookDeliveryState::Exhausted);
        // Disabling stops queued work and refuses redelivery.
        let RedeliverResult::Scheduled(_) =
            store.redeliver_webhook(&owner, &id, 97_000).await.unwrap()
        else {
            panic!("not scheduled")
        };
        let disabled = store
            .disable_webhook_subscription(&owner, &sub, 98_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(disabled.status, WebhookSubscriptionStatus::Disabled);
        let row = &store
            .list_webhook_deliveries(&owner, &sub, 50)
            .await
            .unwrap()[0];
        assert_eq!(row.state, WebhookDeliveryState::Exhausted);
        assert_eq!(
            store.redeliver_webhook(&owner, &id, 99_000).await.unwrap(),
            RedeliverResult::EndpointDisabled
        );
        assert!(
            store
                .rotate_webhook_secrets(&owner, &sub, json!([]), 99_000)
                .await
                .unwrap()
                .is_none()
        );
        let rotated = store
            .rotate_webhook_secrets(&owner, &late, json!([{"sealed": "new"}]), 99_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rotated.secrets, json!([{"sealed": "new"}]));
        // Cap per owner on active endpoints.
        for n in 0..4 {
            let id = format!("whk_{tag}cap{n}");
            let ok = store
                .create_webhook_subscription(subscription(&owner, &id, 100_000), 5)
                .await
                .unwrap();
            assert_eq!(ok, n < 4, "endpoint {n}");
        }
        assert!(
            !store
                .create_webhook_subscription(
                    subscription(&owner, &format!("whk_{tag}over"), 100_000),
                    5
                )
                .await
                .unwrap()
        );
        let listed = store.list_webhook_subscriptions(&owner).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .filter(|s| s.status == WebhookSubscriptionStatus::Active)
                .count(),
            5
        );
        assert!(listed.iter().all(|s| s.owner_wallet == owner));
        // Reconcile listing finds the confirmed payment.
        let page = store
            .list_confirmed_payments(0, u64::MAX >> 2, 10)
            .await
            .unwrap();
        assert!(page.iter().any(|p| p.payment_id == pid));
    }

    #[tokio::test]
    async fn memory_outbox_matches_contract() {
        outbox_scenario(&StatusStore::in_memory(), "m").await;
    }

    #[tokio::test]
    async fn batch_events_follow_the_confirmed_transaction() {
        let store = StatusStore::in_memory();
        store
            .create_webhook_subscription(subscription("o", "whk_1", 1), 5)
            .await
            .unwrap();
        let tx = |status, updated| TransactionRecord {
            transaction_id: "t".into(),
            idempotency_key: "o:k".into(),
            signature: Some("s".into()),
            slot: None,
            status,
            error: None,
            created_at_ms: 1,
            updated_at_ms: updated,
        };
        let events = [event("o", "r1", 5), event("o", "r2", 5)];
        assert_eq!(
            store
                .put_transaction_with_events(tx(PaymentStatus::Submitted, 2), &events)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .put_transaction_with_events(tx(PaymentStatus::Confirmed, 5), &events)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .put_transaction_with_events(tx(PaymentStatus::Confirmed, 6), &events)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .list_webhook_deliveries("o", "whk_1", 10)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn pages_extend_through_ties_and_never_skip() {
        let items = vec![(5, 'a'), (4, 'b'), (4, 'c'), (4, 'd'), (3, 'e'), (9, 'z')];
        let first = page_with_ties(items.clone(), 0, 9, 2);
        assert_eq!(first, vec!['a', 'b', 'c', 'd']);
        assert_eq!(page_with_ties(items, 0, 4, 2), vec!['e']);
    }

    #[tokio::test]
    #[ignore = "requires explicitly isolated TEST_DATABASE_URL"]
    async fn postgres_outbox_matches_memory() {
        let url = std::env::var("TEST_DATABASE_URL").expect("isolated fixture URL required");
        assert!(
            url.starts_with("postgresql://chainpay_test@127.0.0.1:55439/"),
            "Only the explicitly provisioned local fixture is allowed"
        );
        let store = StatusStore::connect(&url).await.unwrap();
        let mut suffix = [0_u8; 6];
        getrandom::fill(&mut suffix).unwrap();
        let tag = suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        outbox_scenario(&store, &tag).await;
        // Concurrent claimers on a real database: SKIP LOCKED + leases.
        let owner = format!("owner-{tag}-c");
        store
            .create_webhook_subscription(subscription(&owner, &format!("whk_{tag}cc"), 1), 5)
            .await
            .unwrap();
        let events: Vec<_> = (0..20)
            .map(|n| event(&owner, &format!("cc{tag}{n}"), 2))
            .collect();
        store.emit_webhook_events(&events).await.unwrap();
        let (a, b) = tokio::join!(
            store.claim_webhook_deliveries(10, 50, 60_000, "lease-x", 8),
            store.claim_webhook_deliveries(10, 50, 60_000, "lease-y", 8)
        );
        let ids = |rows: Vec<ClaimedDelivery>| {
            rows.into_iter()
                .filter(|c| c.delivery.owner_wallet == owner)
                .map(|c| c.delivery.delivery_id)
                .collect::<std::collections::HashSet<_>>()
        };
        let (a, b) = (ids(a.unwrap()), ids(b.unwrap()));
        assert!(a.is_disjoint(&b));
        assert_eq!(a.len() + b.len(), 20);
    }
}
