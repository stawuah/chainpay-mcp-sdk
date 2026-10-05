//! Event emission helpers, the crash-repair reconcile pass, and the bounded
//! dispatcher behind `POST /internal/cron/webhooks/dispatch`.
//!
//! The dispatcher is a short, scheduled request, not a resident worker: each
//! invocation leases due deliveries, sends them, records outcomes and stops
//! inside its time budget. Overlapping or duplicate invocations are harmless
//! because a row can only be leased by one invocation at a time, and only the
//! lease holder can record an outcome.

use super::{
    OutboundRequest, OwnerWebhooks, REQUEST_TIMEOUT, ReceiptReady, SendError, event_id,
    mint_decimals_from_account, ssrf,
};
use crate::server::BackendState;
use crate::status::PaymentRecord;
use crate::storage::{ClaimedDelivery, DeliveryOutcome, WebhookEvent};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Attempts per delivery before it is `exhausted` (a manual redelivery
/// starts a fresh budget for the same event).
pub const MAX_ATTEMPTS: u32 = 8;
/// Seconds to wait after attempt `n` (1-based) fails, before jitter.
/// About 20 hours from first to last attempt.
pub const BACKOFF_SECS: [u64; 7] = [60, 300, 900, 3_600, 10_800, 21_600, 36_000];
/// A lease outlives one batch (DNS 5 s + request 10 s) with room to spare.
pub const LEASE_MS: u64 = 60_000;
pub const BATCH: usize = 10;
/// Confirmed operations older than this are not re-checked for a missing event.
pub const RECONCILE_LOOKBACK_MS: u64 = 72 * 60 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn random_unit() -> f64 {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    f64::from(u32::from_le_bytes(bytes)) / f64::from(u32::MAX)
}

/// Delay before the next attempt, in ms: the schedule step with +/-20%
/// jitter, never shorter than a receiver's `Retry-After` (capped at the
/// longest step).
pub fn backoff_ms(attempts: u32, retry_after_secs: Option<u64>, unit: f64) -> u64 {
    let index = (attempts.max(1) as usize - 1).min(BACKOFF_SECS.len() - 1);
    let base = BACKOFF_SECS[index] as f64 * 1000.0;
    let jittered = (base * (0.8 + 0.4 * unit.clamp(0.0, 1.0))) as u64;
    let floor = retry_after_secs
        .map(|secs| secs.min(*BACKOFF_SECS.last().unwrap()) * 1000)
        .unwrap_or(0);
    jittered.max(floor)
}

async fn decimals(state: &BackendState, mint: Option<&str>) -> Option<u8> {
    let mint = mint?;
    if let Some(known) = super::known_decimals(mint) {
        return Some(known);
    }
    // Unknown is reported as null, never guessed.
    let account = state.rpc.account_info(mint).await.ok()??;
    mint_decimals_from_account(&account.owner, &account.data)
}

/// The receipt-ready event for a payment that just reached `confirmed`.
pub async fn payment_event(
    state: &BackendState,
    hooks: &OwnerWebhooks,
    owner: &str,
    record: &PaymentRecord,
) -> Option<WebhookEvent> {
    let receipt = record.receipt_address.clone()?;
    let data = ReceiptReady {
        operation_id: record.payment_id.clone(),
        operation_kind: "payment",
        cluster: state.config.cluster.to_owned(),
        receipt_address: receipt,
        mint: record.mint.clone(),
        amount: record.amount,
        decimals: decimals(state, record.mint.as_deref()).await,
    };
    Some(hooks.receipt_ready_event(owner, &data, record.updated_at_ms))
}

/// One event per receipt of a batch transaction that just reached `confirmed`.
pub async fn batch_events(
    state: &BackendState,
    hooks: &OwnerWebhooks,
    owner: &str,
    transaction_id: &str,
    receipts: &[PaymentRecord],
    occurred_at_ms: u64,
) -> Vec<WebhookEvent> {
    let mut events = Vec::new();
    for receipt in receipts {
        let Some(address) = receipt.receipt_address.clone() else {
            continue;
        };
        let data = ReceiptReady {
            operation_id: transaction_id.into(),
            operation_kind: "transaction",
            cluster: state.config.cluster.to_owned(),
            receipt_address: address,
            mint: receipt.mint.clone(),
            amount: receipt.amount,
            decimals: decimals(state, receipt.mint.as_deref()).await,
        };
        events.push(hooks.receipt_ready_event(owner, &data, occurred_at_ms));
    }
    events
}

/// Batch receipts bound into a transaction's immutable intent.
pub fn intent_receipts(intent: &serde_json::Value) -> Vec<PaymentRecord> {
    intent["receipts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|receipt| serde_json::from_value(receipt.clone()).ok())
        .collect()
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct ReconcileReport {
    pub checked: u32,
    pub emitted: u32,
    pub without_owner: u32,
    pub complete: bool,
}

/// Find confirmed operations from the lookback window whose event is missing
/// (written before webhooks were enabled, or a bug) and write it. Never
/// re-verifies or changes the payment: `confirmed` is only ever stored after
/// the finalized receipt matched.
pub async fn reconcile(
    state: &BackendState,
    hooks: &OwnerWebhooks,
    deadline: Instant,
) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let now = now_ms();
    let since = now.saturating_sub(RECONCILE_LOOKBACK_MS);
    let mut complete = true;

    let mut before = now + 1;
    loop {
        if Instant::now() >= deadline {
            complete = false;
            break;
        }
        let Ok(page) = state
            .store
            .list_confirmed_payments(since, before, 100)
            .await
        else {
            complete = false;
            break;
        };
        let Some(oldest) = page.iter().map(|p| p.updated_at_ms).min() else {
            break;
        };
        let candidates: Vec<_> = page
            .into_iter()
            .filter_map(|p| {
                let receipt = p.receipt_address.clone()?;
                Some((
                    event_id(super::RECEIPT_READY, super::RECEIPT_READY_VERSION, &receipt),
                    p,
                ))
            })
            .collect();
        report.checked += candidates.len() as u32;
        let ids: Vec<String> = candidates.iter().map(|(id, _)| id.clone()).collect();
        let Ok(missing) = state.store.missing_webhook_events(&ids).await else {
            complete = false;
            break;
        };
        let mut events = Vec::new();
        for (id, payment) in candidates {
            if !missing.contains(&id) {
                continue;
            }
            match state.store.operation_owner(&payment.payment_id).await {
                Ok(Some(owner)) => {
                    if let Some(event) = payment_event(state, hooks, &owner, &payment).await {
                        events.push(event);
                    }
                }
                _ => report.without_owner += 1,
            }
        }
        match state.store.emit_webhook_events(&events).await {
            Ok(created) => report.emitted += created,
            Err(_) => {
                complete = false;
                break;
            }
        }
        before = oldest;
    }

    let mut before = now + 1;
    while complete {
        if Instant::now() >= deadline {
            complete = false;
            break;
        }
        let Ok(page) = state
            .store
            .list_confirmed_transactions(since, before, 100)
            .await
        else {
            complete = false;
            break;
        };
        let Some(oldest) = page.iter().map(|t| t.updated_at_ms).min() else {
            break;
        };
        for transaction in page {
            let Ok(Some((owner, intent, _))) = state
                .store
                .operation_record(&transaction.transaction_id)
                .await
            else {
                report.without_owner += 1;
                continue;
            };
            let receipts = intent_receipts(&intent);
            if receipts.is_empty() {
                continue;
            }
            report.checked += receipts.len() as u32;
            let ids: Vec<String> = receipts
                .iter()
                .filter_map(|r| r.receipt_address.as_deref())
                .map(|r| event_id(super::RECEIPT_READY, super::RECEIPT_READY_VERSION, r))
                .collect();
            let Ok(missing) = state.store.missing_webhook_events(&ids).await else {
                complete = false;
                break;
            };
            if missing.is_empty() {
                continue;
            }
            let events: Vec<_> = batch_events(
                state,
                hooks,
                &owner,
                &transaction.transaction_id,
                &receipts,
                transaction.updated_at_ms,
            )
            .await
            .into_iter()
            .filter(|event| missing.contains(&event.event_id))
            .collect();
            match state.store.emit_webhook_events(&events).await {
                Ok(created) => report.emitted += created,
                Err(_) => {
                    complete = false;
                    break;
                }
            }
        }
        before = oldest;
    }
    report.complete = complete;
    report
}

fn recordable(status: u16) -> Option<u16> {
    (100..=599).contains(&status).then_some(status)
}

/// One attempt for one leased delivery. Never panics and never touches the
/// payment: the worst outcome is a scheduled retry or `exhausted`.
pub async fn deliver(
    hooks: &OwnerWebhooks,
    claimed: &ClaimedDelivery,
    now: u64,
) -> DeliveryOutcome {
    let attempts = claimed.delivery.attempts;
    let failed = |status: Option<u16>, error: String, retry_after: Option<u64>| {
        if attempts >= MAX_ATTEMPTS {
            DeliveryOutcome::Exhausted { status, error }
        } else {
            DeliveryOutcome::Retry {
                status,
                error,
                next_attempt_at_ms: now + backoff_ms(attempts, retry_after, random_unit()),
            }
        }
    };
    let keys = match hooks.signing_keys(&claimed.delivery.subscription_id, &claimed.secrets, now) {
        Ok(keys) => keys,
        Err(_) => {
            return DeliveryOutcome::Exhausted {
                status: None,
                error: "Signing secret unavailable; rotate the endpoint secret".into(),
            };
        }
    };
    let url = match ssrf::validate_url(&claimed.url) {
        Ok(url) => url,
        Err(error) => {
            return DeliveryOutcome::Exhausted {
                status: None,
                error: format!("Destination refused: {error}"),
            };
        }
    };
    let pinned = match ssrf::resolve_public(hooks.resolver.as_ref(), &url).await {
        Ok(pinned) => pinned,
        Err(ssrf::SsrfError::Resolution) => {
            return failed(None, "Host name did not resolve".into(), None);
        }
        Err(error) => {
            return DeliveryOutcome::Exhausted {
                status: None,
                error: format!("Destination refused: {error}"),
            };
        }
    };
    let timestamp = (now / 1000) as i64;
    let id = &claimed.delivery.event_id;
    let body = claimed.event_body.as_bytes().to_vec();
    let request = OutboundRequest {
        url,
        pinned,
        headers: vec![
            ("content-type", "application/json".into()),
            ("webhook-id", id.clone()),
            ("webhook-timestamp", timestamp.to_string()),
            (
                "webhook-signature",
                super::signature_header(&keys, id, timestamp, &body),
            ),
        ],
        body,
    };
    match hooks.transport.send(request).await {
        Ok(response) if (200..300).contains(&response.status) => DeliveryOutcome::Delivered {
            status: response.status,
        },
        Ok(response) if (300..400).contains(&response.status) => failed(
            recordable(response.status),
            format!(
                "Receiver answered {} (redirects are not followed)",
                response.status
            ),
            None,
        ),
        Ok(response) => failed(
            recordable(response.status),
            format!("Receiver answered {}", response.status),
            (response.status == 429 || response.status == 503)
                .then_some(response.retry_after_secs)
                .flatten(),
        ),
        Err(SendError::Timeout) => failed(
            None,
            format!(
                "No answer within {} s (the receiver may still have processed it)",
                REQUEST_TIMEOUT.as_secs()
            ),
            None,
        ),
        Err(SendError::Connect) => failed(None, "Could not connect to the receiver".into(), None),
        Err(SendError::Other) => failed(None, "Request failed before a response".into(), None),
    }
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct DispatchReport {
    pub reconcile: ReconcileReport,
    pub claimed: u32,
    pub delivered: u32,
    pub retry_scheduled: u32,
    pub exhausted: u32,
    /// Outcomes refused because this invocation's lease had already expired.
    pub stale: u32,
    pub storage_errors: u32,
}

/// One bounded dispatcher pass: reconcile missing events, then lease, send
/// and record due deliveries until the time budget is nearly used.
pub async fn run(
    state: &BackendState,
    hooks: Arc<OwnerWebhooks>,
    budget: Duration,
) -> DispatchReport {
    let started = Instant::now();
    let mut report = DispatchReport::default();
    report.reconcile = reconcile(
        state,
        &hooks,
        started + (budget / 5).min(Duration::from_secs(10)),
    )
    .await;
    // Leave room for one full request (DNS + send) after the last claim.
    let reserve = REQUEST_TIMEOUT + Duration::from_secs(8);
    while started.elapsed() + reserve < budget {
        let mut token = [0u8; 16];
        getrandom::fill(&mut token).expect("operating system randomness");
        let token: String = token.iter().map(|b| format!("{b:02x}")).collect();
        let claimed = match state
            .store
            .claim_webhook_deliveries(now_ms(), BATCH, LEASE_MS, &token, MAX_ATTEMPTS)
            .await
        {
            Ok(claimed) => claimed,
            Err(_) => {
                report.storage_errors += 1;
                break;
            }
        };
        if claimed.is_empty() {
            break;
        }
        report.claimed += claimed.len() as u32;
        let mut tasks = tokio::task::JoinSet::new();
        for item in claimed {
            let hooks = hooks.clone();
            let store = state.store.clone();
            let token = token.clone();
            tasks.spawn(async move {
                let outcome = deliver(&hooks, &item, now_ms()).await;
                let recorded = store
                    .complete_webhook_delivery(
                        &item.delivery.delivery_id,
                        &token,
                        &outcome,
                        now_ms(),
                    )
                    .await;
                (outcome, recorded)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((outcome, Ok(true))) => match outcome {
                    DeliveryOutcome::Delivered { .. } => report.delivered += 1,
                    DeliveryOutcome::Retry { .. } => report.retry_scheduled += 1,
                    DeliveryOutcome::Exhausted { .. } => report.exhausted += 1,
                },
                Ok((_, Ok(false))) => report.stale += 1,
                _ => report.storage_errors += 1,
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_with_jitter_and_honours_retry_after() {
        assert_eq!(backoff_ms(1, None, 0.5), 60_000);
        assert_eq!(backoff_ms(1, None, 0.0), 48_000);
        assert_eq!(backoff_ms(1, None, 1.0), 72_000);
        assert_eq!(backoff_ms(2, None, 0.5), 300_000);
        assert_eq!(backoff_ms(7, None, 0.5), 36_000_000);
        assert_eq!(backoff_ms(40, None, 0.5), 36_000_000);
        assert_eq!(backoff_ms(1, Some(600), 0.5), 600_000);
        assert_eq!(backoff_ms(1, Some(u64::MAX), 0.5), 36_000_000);
        assert_eq!(backoff_ms(3, Some(1), 0.5), 900_000);
    }

    #[tokio::test]
    async fn reconcile_writes_missing_events_once_and_skips_unowned_payments() {
        use crate::status::{PaymentStatus, SigningMode, TransactionRecord};
        use crate::storage::{StatusStore, WebhookSubscription, WebhookSubscriptionStatus};
        let mut state = BackendState::new(
            crate::server::BackendConfig::from_env().unwrap(),
            StatusStore::in_memory(),
        )
        .unwrap();
        let (hooks, _) = super::super::test_support::webhooks("127.0.0.1:9".parse().unwrap());
        let secrets = hooks.initial_secrets("whk_r", &OwnerWebhooks::generate_secret(), 0);
        let hooks = Arc::new(hooks);
        state.webhooks = Some(hooks.clone());
        state
            .store
            .create_webhook_subscription(
                WebhookSubscription {
                    subscription_id: "whk_r".into(),
                    owner_wallet: "owner".into(),
                    url: "https://hooks.example.com/".into(),
                    description: None,
                    status: WebhookSubscriptionStatus::Active,
                    secrets,
                    created_at_ms: 0,
                    updated_at_ms: 0,
                },
                5,
            )
            .await
            .unwrap();
        let now = now_ms();
        let payment = |id: &str, receipt: &str| PaymentRecord {
            payment_id: id.into(),
            idempotency_key: format!("owner:{id}"),
            mandate: "mandate".into(),
            invoice_hash: "00".repeat(32),
            receipt_address: Some(receipt.into()),
            agent: None,
            mint: Some("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU".into()),
            recipient: None,
            amount: Some(1_250_000),
            token_program: None,
            signing_mode: SigningMode::Human,
            signature: Some("sig".into()),
            slot: Some(1),
            status: PaymentStatus::Confirmed,
            error: None,
            created_at_ms: now - 1_000,
            updated_at_ms: now - 1_000,
        };
        // Confirmed before webhooks existed (written without an event).
        state
            .store
            .claim_operation(
                "pay_1",
                "owner",
                serde_json::json!({}),
                serde_json::json!({}),
            )
            .await
            .unwrap();
        state
            .store
            .put_payment(payment("pay_1", "RcptA"))
            .await
            .unwrap();
        // A legacy row with no owner reservation cannot be attributed.
        state
            .store
            .put_payment(payment("pay_2", "RcptB"))
            .await
            .unwrap();
        // A confirmed batch with two receipts.
        let receipts = vec![payment("b1", "RcptC"), payment("b2", "RcptD")];
        state
            .store
            .claim_operation(
                "tx_1",
                "owner",
                serde_json::json!({"message": "m", "receipts": receipts}),
                serde_json::json!({}),
            )
            .await
            .unwrap();
        state
            .store
            .put_transaction(TransactionRecord {
                transaction_id: "tx_1".into(),
                idempotency_key: "owner:tx".into(),
                signature: Some("sig".into()),
                slot: Some(1),
                status: PaymentStatus::Confirmed,
                error: None,
                created_at_ms: now - 500,
                updated_at_ms: now - 500,
            })
            .await
            .unwrap();
        // Outside the lookback window: left alone.
        let mut old = payment("pay_3", "RcptOld");
        old.updated_at_ms = now - RECONCILE_LOOKBACK_MS - 60_000;
        state
            .store
            .claim_operation(
                "pay_3",
                "owner",
                serde_json::json!({}),
                serde_json::json!({}),
            )
            .await
            .unwrap();
        state.store.put_payment(old).await.unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let first = reconcile(&state, &hooks, deadline).await;
        assert_eq!(first.emitted, 3);
        assert_eq!(first.without_owner, 1);
        assert!(first.complete);
        let second = reconcile(&state, &hooks, deadline).await;
        assert_eq!(second.emitted, 0);
        let rows = state
            .store
            .list_webhook_deliveries("owner", "whk_r", 10)
            .await
            .unwrap();
        let mut receipts: Vec<_> = rows.iter().map(|r| r.receipt_address.clone()).collect();
        receipts.sort();
        assert_eq!(receipts, ["RcptA", "RcptC", "RcptD"]);
        let batch = state
            .store
            .get_webhook_event(&event_id(super::super::RECEIPT_READY, 1, "RcptC"))
            .await
            .unwrap()
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&batch.body).unwrap();
        assert_eq!(body["data"]["operation_id"], "tx_1");
        assert_eq!(body["data"]["operation_kind"], "transaction");
        assert_eq!(body["data"]["decimals"], 6);
    }
}
