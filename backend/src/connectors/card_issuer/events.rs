//! `POST /v1/cards/lithic/events` (contracts.md §3.2) and the lifecycle
//! processor shared with reconciliation.
//!
//! verify → [`Inbox::accept`] (dedupe on webhook-id, 2xx only after the
//! durable insert) → process. Processing never trusts delivery order: it
//! re-fetches `GET /v1/transactions/{token}` and applies every approved
//! transaction event not yet applied, in the issuer's order. Each event maps
//! to one `card_policy` instruction (research-lithic.md §2); the program's
//! own replay guards (capture ring, event ring) make a retried event a no-op.

use super::program::{self, exception_kind, reservation_state};
use super::tee::{TeeRead, TxOutcome};
use super::{CardsConnector, cents, log_id, now_ms, parse_cents, rfc3339, updated_now};
use crate::connectors::inbox::{Accepted, Inbox, InboxOutcome, WebhookRejection, WebhookVerifier};
use crate::storage::{CardKind, CardPut, StoredCardRecord};
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use solana_address::Address;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub fn inbox(cards: &CardsConnector) -> Inbox<'_> {
    Inbox {
        store: &cards.store,
        sealer: &cards.crypto,
        kind: CardKind::CardEvents,
        provider: super::CONNECTOR,
    }
}

pub async fn handle(cards: Arc<CardsConnector>, headers: HeaderMap, raw: &[u8]) -> Response {
    let verified =
        match cards
            .config
            .events_verifier
            .verify(&headers, raw, (now_ms() / 1000) as i64)
        {
            Ok(verified) => verified,
            Err(WebhookRejection::NotConfigured) => {
                super::card_log!("ALERT events secret not configured");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"code":"events_not_configured","retryable":true})),
                )
                    .into_response();
            }
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"code":"invalid_signature","retryable":false})),
                )
                    .into_response();
            }
        };
    let event_type = verified.body["event_type"]
        .as_str()
        .unwrap_or("unknown")
        .to_owned();
    let accepted = match inbox(&cards)
        .accept(&verified, raw, &event_type, now_ms())
        .await
    {
        Ok(accepted) => accepted,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"storage_unavailable","retryable":true})),
            )
                .into_response();
        }
    };
    let row = accepted.row().clone();
    let duplicate = matches!(accepted, Accepted::Duplicate(_));
    // Durable now. Process inline while the invocation is alive; anything
    // left pending is drained by the cron job.
    if row.record["state"] == "pending" {
        let _ = tokio::time::timeout(Duration::from_secs(8), process_inbox_row(&cards, &row)).await;
    }
    (
        StatusCode::OK,
        Json(json!({"received": true, "duplicate": duplicate})),
    )
        .into_response()
}

/// Process one inbox row and record the outcome on it.
pub async fn process_inbox_row(
    cards: &Arc<CardsConnector>,
    row: &StoredCardRecord,
) -> InboxOutcome {
    let inbox = inbox(cards);
    let outcome = match inbox
        .open_raw(row)
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
    {
        Some(body) => process_body(cards, &body, row).await,
        None => InboxOutcome::Ignored("unreadable".into()),
    };
    let _ = inbox.complete(row, outcome.clone(), now_ms()).await;
    super::card_log!(
        "event {} -> {:?}",
        log_id(&row.key),
        outcome_label(&outcome)
    );
    outcome
}

fn outcome_label(outcome: &InboxOutcome) -> &'static str {
    match outcome {
        InboxOutcome::Applied => "applied",
        InboxOutcome::Retry(_) => "retry",
        InboxOutcome::Ignored(_) => "ignored",
    }
}

async fn process_body(
    cards: &Arc<CardsConnector>,
    body: &Value,
    row: &StoredCardRecord,
) -> InboxOutcome {
    match body["event_type"].as_str().unwrap_or("") {
        "card_transaction.updated" => {
            let (Some(token), Some(card_token)) =
                (body["token"].as_str(), body["card_token"].as_str())
            else {
                return InboxOutcome::Ignored("transaction without token".into());
            };
            let seen: Vec<String> = body["events"]
                .as_array()
                .map(|events| {
                    events
                        .iter()
                        .filter_map(|e| e["token"].as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            process_transaction(cards, token, card_token, &seen).await
        }
        "card.updated" => card_updated(cards, body).await,
        "dispute.updated" | "dispute_transaction.created" | "dispute_transaction.updated" => {
            dispute(cards, body, row).await
        }
        _ => InboxOutcome::Ignored("event type not used".into()),
    }
}

/// `webhook_events`: event tokens the delivery itself listed. Issuer truth
/// can lag the webhook; if it does not yet show them, refetch once, then
/// leave the row for the cron job rather than mark it applied.
pub async fn process_transaction(
    cards: &Arc<CardsConnector>,
    token: &str,
    card_token: &str,
    webhook_events: &[String],
) -> InboxOutcome {
    let card = match cards.card_by_token(card_token).await {
        Ok(Some(card)) => card,
        Ok(None) => return InboxOutcome::Ignored("unknown card".into()),
        Err(_) => return InboxOutcome::Retry("storage".into()),
    };
    let mut attempt = 0;
    let truth = loop {
        attempt += 1;
        let truth = match cards.lithic.get_transaction(token).await {
            Ok(truth) => truth,
            Err(error) if error.is_not_found() => {
                return InboxOutcome::Retry("transaction not yet visible".into());
            }
            Err(_) => return InboxOutcome::Retry("issuer unavailable".into()),
        };
        let known: Vec<&str> = truth["events"]
            .as_array()
            .map(|events| events.iter().filter_map(|e| e["token"].as_str()).collect())
            .unwrap_or_default();
        if webhook_events.iter().all(|t| known.contains(&t.as_str())) {
            break truth;
        }
        if attempt >= 2 {
            return InboxOutcome::Retry("issuer truth behind the webhook".into());
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    };
    match apply_transaction(cards, &card, &truth).await {
        Ok(()) => InboxOutcome::Applied,
        Err(reason) => InboxOutcome::Retry(reason),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CardPdas {
    policy: Address,
    period: Address,
}

fn pdas(card: &StoredCardRecord) -> Option<CardPdas> {
    Some(CardPdas {
        policy: card.record["policyPda"].as_str()?.parse().ok()?,
        period: card.record["periodPda"].as_str()?.parse().ok()?,
    })
}

/// Event amount in cents. The sandbox reports `amounts.cardholder.amount = 0`
/// on RETURN events while `amount` carries the value, so take the first
/// non-zero of cardholder, event amount, settlement.
fn event_amount(event: &Value) -> u64 {
    [
        &event["amounts"]["cardholder"]["amount"],
        &event["amount"],
        &event["amounts"]["settlement"]["amount"],
    ]
    .into_iter()
    .filter_map(|v| v.as_i64().map(i64::unsigned_abs))
    .find(|v| *v > 0)
    .unwrap_or(0)
}

/// States in which `card_policy` holds a Reservation for this transaction.
fn has_reservation(record: &Value) -> bool {
    record["hasReservation"].as_bool().unwrap_or(false)
        || matches!(
            record["state"].as_str(),
            Some("reserved" | "partially_captured" | "captured" | "reversed" | "expired")
        ) && record["unsolicited"].as_bool() != Some(true)
}

fn sorted_events(truth: &Value) -> Vec<Value> {
    let mut events: Vec<Value> = truth["events"].as_array().cloned().unwrap_or_default();
    events.sort_by(|a, b| {
        a["created"]
            .as_str()
            .unwrap_or("")
            .cmp(b["created"].as_str().unwrap_or(""))
    });
    events
}

enum Step {
    Program(solana_message::Instruction, &'static str),
    Local(&'static str),
    Skip,
}

/// Apply issuer truth for one transaction. Idempotent and reorder-safe.
pub async fn apply_transaction(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    truth: &Value,
) -> Result<(), String> {
    let token = truth["token"]
        .as_str()
        .ok_or("transaction without token")?
        .to_owned();
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    let pdas = pdas(card).ok_or("card accounts missing")?;
    let row = match cards.txn(&token).await.map_err(|_| "storage")? {
        Some(row) => row,
        None => create_unsolicited(cards, &token, &owner, &card_id, truth).await?,
    };
    match row.record["state"].as_str() {
        Some("pending") => {
            // The ASA invocation is still deciding (or crashed). Leave it to
            // that invocation, or to reconciliation once it is stale.
            return Err("authorization decision in flight".into());
        }
        Some("ambiguous") => {
            super::reconcile::resolve_ambiguous(cards, card, &row, truth).await?;
        }
        _ => {}
    }
    let row = cards
        .txn(&token)
        .await
        .map_err(|_| "storage")?
        .ok_or("record vanished")?;
    let original = row.record.clone();
    let mut record = row.record.clone();
    let reservation_present = has_reservation(&record);
    let auth_id = program::auth_id_hash(cards.config.issuer_code, &token);
    let reservation = program::reservation_pda(&pdas.policy, &auth_id);
    let applied: Vec<String> = record["appliedEventIds"]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut newly_applied = Vec::new();
    let mut signatures = Vec::new();
    let mut notes: Vec<Value> = Vec::new();
    let authorizer = cards.authorizer();
    let mut stop: Option<String> = None;
    // Money movements PER confirmed in this pass, booked as statement
    // postings before the row is marked applied (a crash in between
    // re-submits, gets Duplicate*, and books the posting then).
    let mut postings: Vec<([u8; 32], &'static str, u64)> = Vec::new();
    for event in sorted_events(truth) {
        let Some(event_token) = event["token"].as_str() else {
            continue;
        };
        let id = program::event_id_hash(cards.config.issuer_code, event_token);
        let id_hex = program::hex(&id);
        if applied.contains(&id_hex) {
            continue;
        }
        if event["result"].as_str().is_some_and(|r| r != "APPROVED") {
            // Declined issuer events move no money.
            newly_applied.push(id_hex);
            continue;
        }
        let amount = event_amount(&event);
        let credit = event["effective_polarity"].as_str() == Some("CREDIT");
        let kind = event["type"].as_str().unwrap_or("");
        let step = match kind {
            "AUTHORIZATION" if reservation_present => Step::Skip,
            // A $0 verification ChainPay approved itself (no hold by design).
            "AUTHORIZATION" if record["state"] == "account_verification" && amount == 0 => {
                Step::Skip
            }
            "AUTHORIZATION" => Step::Local("unpaired_authorization"),
            "FINANCIAL_AUTHORIZATION" if reservation_present => Step::Skip,
            "FINANCIAL_AUTHORIZATION" => Step::Program(
                program::record_exception(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    None,
                    exception_kind::UNPAIRED_CAPTURE,
                    amount,
                    &id,
                ),
                "unpaired_capture",
            ),
            "AUTHORIZATION_ADVICE" if reservation_present => {
                let new_total = advice_total(&event, truth);
                Step::Program(
                    program::adjust_reservation(
                        &authorizer,
                        &pdas.policy,
                        &pdas.period,
                        &reservation,
                        new_total,
                    ),
                    "adjust",
                )
            }
            "CLEARING" if credit => Step::Program(
                program::refund(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    reservation_present.then_some(&reservation),
                    amount,
                    &id,
                ),
                "refund",
            ),
            "CLEARING" if reservation_present => Step::Program(
                program::capture(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    &reservation,
                    amount,
                    &id,
                ),
                "capture",
            ),
            // A capture with no authorization we reserved: forced post.
            "CLEARING" => Step::Program(
                program::record_exception(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    None,
                    exception_kind::FORCED_CAPTURE,
                    amount,
                    &id,
                ),
                "forced_capture",
            ),
            "AUTHORIZATION_REVERSAL" if reservation_present => Step::Program(
                program::reverse(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    &reservation,
                    amount,
                    0,
                    &id,
                ),
                "reverse",
            ),
            "AUTHORIZATION_EXPIRY" if reservation_present => Step::Program(
                program::reverse(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    &reservation,
                    amount,
                    1,
                    &id,
                ),
                "expire",
            ),
            "RETURN" | "FINANCIAL_CREDIT_AUTHORIZATION" => Step::Program(
                program::refund(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    reservation_present.then_some(&reservation),
                    amount,
                    &id,
                ),
                "refund",
            ),
            "RETURN_REVERSAL" => Step::Program(
                program::record_exception(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    reservation_present.then_some(&reservation),
                    exception_kind::RETURN_REVERSAL,
                    amount,
                    &id,
                ),
                "return_reversal",
            ),
            "CORRECTION_DEBIT" => Step::Program(
                program::record_exception(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    reservation_present.then_some(&reservation),
                    exception_kind::CORRECTION_DEBIT,
                    amount,
                    &id,
                ),
                "correction_debit",
            ),
            "CORRECTION_CREDIT" => Step::Program(
                program::record_exception(
                    &authorizer,
                    &pdas.policy,
                    &pdas.period,
                    reservation_present.then_some(&reservation),
                    exception_kind::CORRECTION_CREDIT,
                    amount,
                    &id,
                ),
                "correction_credit",
            ),
            _ => Step::Skip,
        };
        match step {
            Step::Skip => newly_applied.push(id_hex),
            Step::Local(label) => {
                notes.push(json!({"event": id_hex, "kind": label}));
                record["needsReview"] = json!(true);
                record["exception"] = json!(label);
                newly_applied.push(id_hex);
            }
            Step::Program(instruction, label) => {
                let outcome = cards
                    .per
                    .submit(vec![instruction], Instant::now() + Duration::from_secs(6))
                    .await;
                match &outcome {
                    TxOutcome::Confirmed { signature } => {
                        signatures.push(signature.clone());
                        apply_label(&mut record, label, amount);
                        note_exception(&mut record, label, &id_hex);
                        postings.push((id, label, amount));
                        newly_applied.push(id_hex);
                    }
                    TxOutcome::ProgramError { code, signature } => match program::error_name(*code)
                    {
                        // Already applied by an earlier attempt.
                        Some("DuplicateCapture" | "DuplicateEvent") => {
                            apply_label(&mut record, label, amount);
                            note_exception(&mut record, label, &id_hex);
                            postings.push((id, label, amount));
                            newly_applied.push(id_hex);
                        }
                        // Releasing a hold that is already gone is a true no-op.
                        Some("ReservationClosed") if matches!(label, "reverse" | "expire") => {
                            notes.push(json!({"event": id_hex, "kind": label, "noop": "reservation_closed"}));
                            newly_applied.push(id_hex);
                        }
                        Some(
                            "BudgetExceeded" | "AmountExceedsMax" | "CardFrozen" | "RecoveryFrozen"
                            | "PolicyExpired",
                        ) if label == "adjust" => {
                            // An incremental hold that does not fit: the hold
                            // stays and the excess is flagged (contracts.md #10).
                            let current =
                                parse_cents(record["reservedCents"].as_str().unwrap_or("0"))
                                    .unwrap_or(0);
                            let excess = advice_total(&event, truth).saturating_sub(current);
                            let exception = program::record_exception(
                                &authorizer,
                                &pdas.policy,
                                &pdas.period,
                                Some(&reservation),
                                exception_kind::OVER_HOLD,
                                excess,
                                &id,
                            );
                            match cards
                                .per
                                .submit(vec![exception], Instant::now() + Duration::from_secs(6))
                                .await
                            {
                                TxOutcome::Confirmed { signature } => {
                                    signatures.push(signature);
                                    apply_label(&mut record, "over_hold", excess);
                                    note_exception(&mut record, "over_hold", &id_hex);
                                    newly_applied.push(id_hex);
                                }
                                TxOutcome::ProgramError { code, .. }
                                    if program::error_name(code) == Some("DuplicateEvent") =>
                                {
                                    newly_applied.push(id_hex)
                                }
                                _ => {
                                    stop = Some("over-hold exception not confirmed".into());
                                    break;
                                }
                            }
                        }
                        other => {
                            notes.push(json!({"event": id_hex, "kind": label, "programError": other, "signature": signature}));
                            record["needsReview"] = json!(true);
                            newly_applied.push(id_hex);
                        }
                    },
                    TxOutcome::Failed { .. } | TxOutcome::Unknown { .. } => {
                        // Keep issuer order: stop here and retry the rest later.
                        stop = Some(format!("{label} not confirmed"));
                        break;
                    }
                }
            }
        }
    }
    if reservation_present {
        refresh_from_reservation(cards, &mut record, &reservation).await;
        // An over-capture is flagged by the program on the capture itself.
        if record["exception"] == "over_capture" && record["exceptionEventId"].is_null() {
            if let Some((id, _, _)) = postings.iter().rev().find(|(_, l, _)| *l == "capture") {
                record["exceptionEventId"] = json!(program::hex(id));
            }
        }
    }
    if !postings.is_empty() {
        let display = super::merchant_display(cards, &row);
        for (id, label, amount) in &postings {
            if !super::statements::record_posting(cards, card, id, label, *amount, &display).await {
                // Not billed yet: leave the whole pass unapplied. The retry
                // gets Duplicate* from the program and books the posting then
                // (postings are keyed by event id, so nothing doubles).
                return Err("statement posting not stored".into());
            }
            if matches!(*label, "forced_capture" | "unpaired_capture") {
                cards.metrics.count("unpaired_captures");
            }
        }
        cards.metrics.add("events_applied", postings.len() as u64);
    }
    let all_applied: Vec<String> = applied
        .iter()
        .cloned()
        .chain(newly_applied.iter().cloned())
        .collect();
    let progressed = !newly_applied.is_empty();
    if progressed || !signatures.is_empty() {
        cards
            .update_txn(&token, |current| {
                // Merge onto the latest copy: union applied ids and keep the
                // most advanced money fields from this pass.
                let mut ids: Vec<String> = current["appliedEventIds"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                for id in &all_applied {
                    if !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
                for field in [
                    "state",
                    "reservedCents",
                    "capturedCents",
                    "reversedCents",
                    "refundedCents",
                    "exceptionCents",
                    "flags",
                    "disputeState",
                    "needsReview",
                    "exception",
                    "exceptionEventId",
                    "issuerStatus",
                ] {
                    // Only fields this pass changed: never revert a concurrent
                    // writer (e.g. a dispute webhook) with a stale copy.
                    if !record[field].is_null() && record[field] != original[field] {
                        current[field] = record[field].clone();
                    }
                }
                current["appliedEventIds"] = json!(ids);
                if let Some(list) = current["perTx"].as_array_mut() {
                    for signature in &signatures {
                        list.push(json!(signature));
                    }
                }
                if !notes.is_empty() {
                    let mut all = current["notes"].as_array().cloned().unwrap_or_default();
                    all.extend(notes.iter().cloned());
                    all.truncate(32);
                    current["notes"] = json!(all);
                }
                current["issuerStatus"] = truth["status"].clone();
                true
            })
            .await
            .map_err(|_| "storage")?;
        super::reconcile::maybe_snapshot(cards, card).await;
    }
    match stop {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// `AUTHORIZATION_ADVICE` carries the new total authorization amount
/// (Lithic `simulate/authorization_advice` "overrides the pending amount").
fn advice_total(event: &Value, _truth: &Value) -> u64 {
    event_amount(event)
}

fn add_cents(record: &mut Value, field: &str, amount: u64) {
    let current = parse_cents(record[field].as_str().unwrap_or("0")).unwrap_or(0);
    record[field] = json!(cents(current.saturating_add(amount)));
}

fn flag(record: &mut Value, name: &str) {
    if !record["flags"].is_object() {
        record["flags"] = json!({});
    }
    record["flags"][name] = json!(true);
}

/// Keep the event id of the newest exception on the row: the owner passes it
/// to `resolve_exception` (activity `eventIdHash`).
fn note_exception(record: &mut Value, label: &str, id_hex: &str) {
    if matches!(
        label,
        "forced_capture"
            | "unpaired_capture"
            | "over_hold"
            | "return_reversal"
            | "correction_debit"
            | "correction_credit"
    ) {
        record["exceptionEventId"] = json!(id_hex);
    }
}

/// Local projection for transactions without a PER Reservation (and as a
/// fallback until the reservation is re-read).
fn apply_label(record: &mut Value, label: &str, amount: u64) {
    match label {
        "capture" => add_cents(record, "capturedCents", amount),
        "reverse" | "expire" => add_cents(record, "reversedCents", amount),
        "refund" => {
            add_cents(record, "refundedCents", amount);
            flag(record, "refunded");
            if record["unsolicited"] == true {
                record["state"] = json!("refunded");
            }
        }
        "forced_capture" | "unpaired_capture" => {
            add_cents(record, "capturedCents", amount);
            add_cents(record, "exceptionCents", amount);
            flag(record, "forced");
            record["state"] = json!("forced_capture");
            record["needsReview"] = json!(true);
            record["exception"] = json!(label);
        }
        "over_hold" | "return_reversal" | "correction_debit" => {
            add_cents(record, "exceptionCents", amount);
            record["needsReview"] = json!(true);
            record["exception"] = json!(label);
        }
        "correction_credit" => {
            record["needsReview"] = json!(true);
            record["exception"] = json!(label);
        }
        _ => {}
    }
}

/// PER is the source of truth for reservation money fields and lifecycle.
pub async fn refresh_from_reservation(
    cards: &CardsConnector,
    record: &mut Value,
    reservation: &Address,
) {
    if let TeeRead::Visible { data, .. } = cards.per.read(reservation, Duration::from_secs(4)).await
    {
        if let Ok(r) = program::decode_reservation(&data) {
            record["hasReservation"] = json!(true);
            record["reservedCents"] = json!(cents(r.amount_reserved_cents));
            record["capturedCents"] = json!(cents(r.captured_cents));
            record["reversedCents"] = json!(cents(r.reversed_cents));
            record["refundedCents"] = json!(cents(r.refunded_cents));
            record["state"] = json!(match r.state {
                reservation_state::RESERVED => "reserved",
                reservation_state::PARTIALLY_CAPTURED => "partially_captured",
                reservation_state::CAPTURED => "captured",
                reservation_state::REVERSED => "reversed",
                reservation_state::EXPIRED => "expired",
                _ => "reserved",
            });
            record["disputeState"] = json!(r.dispute_state);
            if r.flags & program::FLAG_LATE_CAPTURE != 0 {
                flag(record, "lateCapture");
            }
            if r.flags & program::FLAG_OVER_CAPTURE != 0 {
                flag(record, "overCapture");
                record["needsReview"] = json!(true);
                record["exception"] = json!("over_capture");
            }
            if r.refunded_cents > 0 {
                flag(record, "refunded");
            }
        }
    }
}

async fn create_unsolicited(
    cards: &CardsConnector,
    token: &str,
    owner: &str,
    card_id: &str,
    truth: &Value,
) -> Result<StoredCardRecord, String> {
    let key = CardsConnector::txn_key(token);
    let merchant = &truth["merchant"];
    let provider = json!({
        "txnToken": token,
        "status": truth["status"],
        "merchant": {"acceptorId": merchant["acceptor_id"], "descriptor": merchant["descriptor"], "mcc": merchant["mcc"], "city": merchant["city"], "country": merchant["country"]},
    });
    let approved_any = truth["events"].as_array().is_some_and(|events| {
        events
            .iter()
            .any(|e| e["result"].as_str() == Some("APPROVED"))
    });
    let issuer_result = truth["result"].as_str().unwrap_or("DECLINED").to_owned();
    let record = json!({
        "v": 1,
        "type": "transaction",
        "cardId": card_id,
        // Declined by the issuer before it reached us (paused card, issuer
        // limits): a decline, never an exception.
        "state": if approved_any { "unsolicited" } else { "declined" },
        "decision": if approved_any { Value::Null } else { json!({"result": issuer_result, "reason": issuer_decline_reason(&issuer_result), "by": "issuer", "at": rfc3339(now_ms())}) },
        "unsolicited": true,
        "amountCents": cents(event_amount(&truth["events"][0])),
        "reservedCents": "0", "capturedCents": "0", "reversedCents": "0", "refundedCents": "0", "exceptionCents": "0",
        "appliedEventIds": [], "perTx": [], "flags": {},
        "receivedAt": rfc3339(now_ms()),
        "provider": cards.crypto.seal_json(CardKind::CardEvents.as_str(), &key, &provider),
    });
    match cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &key,
            CardsConnector::txn_index(owner, card_id),
            record,
            None,
            updated_now(),
        )
        .await
        .map_err(|_| "storage".to_owned())?
    {
        CardPut::Written(row) | CardPut::Conflict(Some(row)) => Ok(row),
        CardPut::Conflict(None) => Err("record race".into()),
    }
}

/// Map an issuer-side decline to the UI decline reasons (contracts.md §9).
fn issuer_decline_reason(result: &str) -> &'static str {
    match result {
        "CARD_PAUSED" | "CARD_CLOSED" => "frozen",
        "UNAUTHORIZED_MERCHANT" => "merchant_not_allowed",
        "INSUFFICIENT_FUNDS" => "over_budget",
        r if r.contains("LIMIT") => "over_max",
        _ => "internal",
    }
}

async fn card_updated(cards: &Arc<CardsConnector>, body: &Value) -> InboxOutcome {
    let (Some(card_token), Some(state)) = (body["card_token"].as_str(), body["state"].as_str())
    else {
        return InboxOutcome::Ignored("card event without token".into());
    };
    let card = match cards.card_by_token(card_token).await {
        Ok(Some(card)) => card,
        Ok(None) => return InboxOutcome::Ignored("unknown card".into()),
        Err(_) => return InboxOutcome::Retry("storage".into()),
    };
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let at = rfc3339(now_ms());
    let mut acked = false;
    let result = cards
        .update_card(&card_id, |record| {
            record["issuerState"] = json!(state);
            let wanted = record["freeze"]["wantedIssuerState"]
                .as_str()
                .map(str::to_owned);
            acked = false;
            if wanted.as_deref() == Some(state) && record["freeze"]["issuer"] != "confirmed" {
                acked = true;
                record["freeze"]["issuer"] = json!("confirmed");
                record["freeze"]["ackAt"] = json!(at);
                record["freeze"]["ackSource"] = json!("card.updated");
            }
        })
        .await;
    if acked && result.is_ok() {
        cards.metrics.count("freeze_acks");
    }
    match result {
        Ok(_) => InboxOutcome::Applied,
        Err(_) => InboxOutcome::Retry("storage".into()),
    }
}

fn dispute_state(body: &Value) -> u8 {
    let status = body["status"].as_str().unwrap_or("");
    let disposition = body["disposition"].as_str().unwrap_or("");
    let resolution = body["resolution_reason"].as_str().unwrap_or("");
    match (status, disposition) {
        ("CASE_WON", _) | (_, "WON") => 2,
        (_, "WITHDRAWN") => 4,
        ("CASE_CLOSED", _) if resolution.contains("WITHDRAWN") => 4,
        ("CASE_CLOSED", _) | (_, "LOST") => 3,
        _ => 1,
    }
}

async fn dispute(
    cards: &Arc<CardsConnector>,
    body: &Value,
    row: &StoredCardRecord,
) -> InboxOutcome {
    let token = body["transaction_token"]
        .as_str()
        .or_else(|| body["transaction_series"]["related_transaction_token"].as_str());
    let Some(token) = token else {
        return InboxOutcome::Ignored("dispute without transaction".into());
    };
    let Ok(Some(txn)) = cards.txn(token).await else {
        return InboxOutcome::Ignored("dispute for an unknown transaction".into());
    };
    let Some(card_id) = txn.record["cardId"].as_str() else {
        return InboxOutcome::Ignored("dispute without card".into());
    };
    let Ok(Some(card)) = cards.card(card_id).await else {
        return InboxOutcome::Ignored("unknown card".into());
    };
    let state = dispute_state(body);
    let id = program::event_id_hash(cards.config.issuer_code, &row.key);
    if has_reservation(&txn.record) {
        let Some(pdas) = pdas(&card) else {
            return InboxOutcome::Ignored("card accounts missing".into());
        };
        let reservation = program::reservation_pda(
            &pdas.policy,
            &program::auth_id_hash(cards.config.issuer_code, token),
        );
        let instruction = program::record_dispute(
            &cards.authorizer(),
            &pdas.policy,
            &pdas.period,
            &reservation,
            state,
            &id,
        );
        match cards
            .per
            .submit(vec![instruction], Instant::now() + Duration::from_secs(6))
            .await
        {
            TxOutcome::Confirmed { .. } => {}
            TxOutcome::ProgramError { code, .. }
                if program::error_name(code) == Some("DuplicateEvent") => {}
            TxOutcome::ProgramError { .. } => {}
            _ => return InboxOutcome::Retry("dispute not confirmed".into()),
        }
    }
    match cards
        .update_txn(token, |record| {
            record["disputeState"] = json!(state);
            true
        })
        .await
    {
        Ok(_) => InboxOutcome::Applied,
        Err(_) => InboxOutcome::Retry("storage".into()),
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn dispute_statuses_map_to_program_states() {
        assert_eq!(dispute_state(&json!({"status":"NEW"})), 1);
        assert_eq!(dispute_state(&json!({"status":"CASE_WON"})), 2);
        assert_eq!(dispute_state(&json!({"status":"CASE_CLOSED"})), 3);
        assert_eq!(
            dispute_state(&json!({"status":"CASE_CLOSED","resolution_reason":"WITHDRAWN"})),
            4
        );
        assert_eq!(dispute_state(&json!({"disposition":"WON"})), 2);
    }

    #[test]
    fn events_sort_by_issuer_time_and_amounts_are_absolute() {
        let truth = json!({"events":[{"created":"2026-10-04T00:00:02Z","token":"b"},{"created":"2026-10-04T00:00:01Z","token":"a"}]});
        let sorted = sorted_events(&truth);
        assert_eq!(sorted[0]["token"], "a");
        assert_eq!(event_amount(&json!({"amount":-1500})), 1500);
        assert_eq!(
            event_amount(&json!({"amounts":{"cardholder":{"amount":700}},"amount":1})),
            700
        );
    }
}
