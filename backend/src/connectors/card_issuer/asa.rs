//! `POST /v1/cards/lithic/asa` (contracts.md §3.1).
//!
//! verify HMAC → parse allowlisted fields → card lookup → claim
//! `card-asa:v1:<token>` → match a ChainPay-opened checkout intent →
//! `authorize` on PER → approve **only after** the Reservation is observed,
//! all inside the 2 s budget. Timeouts and errors decline. A transaction that
//! may have landed but was not observed in time becomes `ambiguous`; it is
//! never released on a timer, only by reconciliation against PER and issuer
//! truth. Every verified request gets HTTP 200 so Lithic does not retry a
//! decision we already made, and the decision is persisted before replying.

use super::program::{self, reservation_state};
use super::tee::{TeeRead, TxOutcome};
use super::{CONNECTOR, CardsConnector, cents, log_id, now_ms, rfc3339, updated_now};
use crate::connectors::inbox::{WebhookRejection, WebhookVerifier};
use crate::storage::{CardKind, CardPut, StoredCardRecord};
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const APPROVED: &str = "APPROVED";
pub const CARD_PAUSED: &str = "CARD_PAUSED";
pub const UNAUTHORIZED_MERCHANT: &str = "UNAUTHORIZED_MERCHANT";
pub const INSUFFICIENT_FUNDS: &str = "INSUFFICIENT_FUNDS";
pub const SUSPECTED_FRAUD: &str = "SUSPECTED_FRAUD";

#[derive(Debug, Clone, PartialEq)]
pub struct AsaRequest {
    pub token: String,
    pub status: String,
    pub amount_cents: u64,
    pub currency: String,
    pub cash_cents: u64,
    pub card_token: String,
    pub acceptor_id: String,
    pub descriptor: String,
    pub mcc: u16,
    pub mcc_raw: String,
    pub city: String,
    pub country: String,
    pub merchant_initiated: bool,
}

/// Read only the allowlisted fields of `card_authorization.approval_request`.
/// The reserved amount is `max(cardholder.amount, hold.amount)` in USD.
pub fn parse(body: &Value) -> Option<AsaRequest> {
    let token = body["token"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= 64)?
        .to_owned();
    let status = body["status"].as_str()?.to_owned();
    let cardholder = &body["amounts"]["cardholder"];
    let amount = cardholder["amount"]
        .as_u64()
        .or_else(|| body["amount"].as_u64())
        .unwrap_or(0);
    let hold = body["amounts"]["hold"]["amount"].as_u64().unwrap_or(0);
    let currency = cardholder["currency"]
        .as_str()
        .or_else(|| body["cardholder_currency"].as_str())
        .unwrap_or("USD")
        .to_owned();
    let merchant = &body["merchant"];
    let mcc_raw = merchant["mcc"].as_str().unwrap_or("").to_owned();
    Some(AsaRequest {
        token,
        status,
        amount_cents: amount.max(hold),
        currency,
        cash_cents: body["cash_amount"].as_u64().unwrap_or(0),
        card_token: body["card"]["token"]
            .as_str()
            .or_else(|| body["card_token"].as_str())?
            .to_owned(),
        acceptor_id: merchant["acceptor_id"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned(),
        descriptor: merchant["descriptor"].as_str().unwrap_or("").to_owned(),
        mcc: mcc_raw.trim().parse().unwrap_or(0),
        mcc_raw,
        city: merchant["city"].as_str().unwrap_or("").to_owned(),
        country: merchant["country"].as_str().unwrap_or("").to_owned(),
        merchant_initiated: body["transaction_initiator"].as_str() == Some("MERCHANT"),
    })
}

/// The only response shape we ever send: no `approved_amount` (no partial
/// approvals), no `balance` (never leak budget to a merchant).
pub fn reply(token: &str, result: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({"token": token, "result": result})),
    )
        .into_response()
}

fn rejection(rejection: WebhookRejection) -> Response {
    match rejection {
        WebhookRejection::NotConfigured => {
            super::card_log!("ALERT ASA secret not configured; refusing to decide");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"code":"asa_not_configured","retryable":true})),
            )
                .into_response()
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":"invalid_signature","retryable":false})),
        )
            .into_response(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub result: &'static str,
    /// `reserved`, `captured` (single message), `declined`, `declined_internal`,
    /// `ambiguous`, `account_verification`.
    pub state: &'static str,
    pub reason: Option<&'static str>,
    pub program_error: Option<&'static str>,
    pub signature: Option<String>,
    pub intent_id: Option<String>,
    pub reserved_cents: u64,
}

impl Decision {
    fn decline(result: &'static str, state: &'static str, reason: &'static str) -> Self {
        Self {
            result,
            state,
            reason: Some(reason),
            program_error: None,
            signature: None,
            intent_id: None,
            reserved_cents: 0,
        }
    }
}

pub async fn handle(cards: Arc<CardsConnector>, headers: HeaderMap, raw: &[u8]) -> Response {
    let received = Instant::now();
    let deadline = received + cards.config.asa_budget;
    let verified = match cards
        .config
        .asa_verifier
        .verify(&headers, raw, (now_ms() / 1000) as i64)
    {
        Ok(verified) => verified,
        Err(error) => return rejection(error),
    };
    cards.refresh_attestation_if_stale();
    let Some(request) = parse(&verified.body) else {
        // Verified but unparseable: decline without a token we can trust.
        let token = verified.body["token"].as_str().unwrap_or("");
        return reply(token, SUSPECTED_FRAUD);
    };
    let result = decide(&cards, &request, deadline).await;
    cards.metrics.asa_latency(received.elapsed().as_millis());
    cards.metrics.count("asa_decisions");
    if result == APPROVED {
        cards.metrics.count("asa_approved");
    }
    super::card_log!(
        "asa {} -> {} ({} ms)",
        log_id(&request.token),
        result,
        received.elapsed().as_millis()
    );
    reply(&request.token, result)
}

/// Claim intent for `operation_claims` (plaintext in Convex): only a keyed
/// digest of the authorization, so a replay with different terms is still
/// detected but amounts, merchant and MCC never sit there in the clear.
fn claim_intent(
    cards: &CardsConnector,
    card_id: &str,
    request: &AsaRequest,
    merchant_hash: &[u8; 32],
) -> Value {
    let terms = json!({
        "cardId": card_id,
        "amountCents": cents(request.amount_cents),
        "merchant": program::hex(merchant_hash),
        "mcc": request.mcc,
        "status": request.status,
        "currency": request.currency,
        "merchantInitiated": request.merchant_initiated,
    });
    json!({
        "v": 2,
        "cardId": card_id,
        "terms": cards.crypto.blind("asa-terms", terms.to_string().as_bytes()),
    })
}

pub async fn decide(
    cards: &Arc<CardsConnector>,
    request: &AsaRequest,
    deadline: Instant,
) -> &'static str {
    match request.status.as_str() {
        // Never answer with a balance: budget stays private.
        "BALANCE_INQUIRY" => return APPROVED,
        // Credits are recorded later as refunds through the events webhook.
        "CREDIT_AUTHORIZATION" | "FINANCIAL_CREDIT_AUTHORIZATION" => return APPROVED,
        "AUTHORIZATION" | "FINANCIAL_AUTHORIZATION" => {}
        _ => return SUSPECTED_FRAUD,
    }
    let card = match cards.card_by_token(&request.card_token).await {
        Ok(Some(card)) => card,
        Ok(None) => return UNAUTHORIZED_MERCHANT,
        Err(_) => return SUSPECTED_FRAUD,
    };
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    let merchant_hash = program::merchant_id_hash(&request.acceptor_id);
    let claim_id = format!("card-asa:v1:{}", request.token);
    let intent = claim_intent(cards, &card_id, request, &merchant_hash);
    let claim = cards
        .store
        .claim_operation(
            &claim_id,
            &owner,
            intent.clone(),
            json!({"state":"pending"}),
        )
        .await;
    let (won, _, stored_intent, _) = match claim {
        Ok(claim) => claim,
        Err(_) => return SUSPECTED_FRAUD,
    };
    if !won {
        return duplicate(cards, request, &card, &intent, &stored_intent, deadline).await;
    }
    // The pending row exists before anything reaches PER, so a crash between
    // here and the decision is found by reconciliation (stale pending).
    if create_pending(cards, request, &card, &owner, &card_id, &merchant_hash)
        .await
        .is_err()
    {
        return SUSPECTED_FRAUD;
    }
    let decision = evaluate(
        cards,
        request,
        &card,
        &card_id,
        &owner,
        &merchant_hash,
        deadline,
    )
    .await;
    match persist(cards, request, &decision).await {
        Ok(()) => decision.result,
        // Without a durable decision we never approve. A reservation that did
        // land stays `pending`, and reconciliation reverses it against the
        // issuer's decline.
        Err(_) => SUSPECTED_FRAUD,
    }
}

async fn create_pending(
    cards: &CardsConnector,
    request: &AsaRequest,
    card: &StoredCardRecord,
    owner: &str,
    card_id: &str,
    merchant_hash: &[u8; 32],
) -> Result<(), ()> {
    let key = CardsConnector::txn_key(&request.token);
    let provider = json!({
        "txnToken": request.token,
        "status": request.status,
        "amountCents": cents(request.amount_cents),
        "currency": request.currency,
        "merchant": {"acceptorId": request.acceptor_id, "descriptor": request.descriptor, "mcc": request.mcc_raw, "city": request.city, "country": request.country},
        "merchantInitiated": request.merchant_initiated,
    });
    let record = json!({
        "v": 1,
        "type": "transaction",
        "cardId": card_id,
        "state": "pending",
        "amountCents": cents(request.amount_cents),
        "reservedCents": "0", "capturedCents": "0", "reversedCents": "0", "refundedCents": "0", "exceptionCents": "0",
        "singleMessage": request.status == "FINANCIAL_AUTHORIZATION",
        "appliedEventIds": [],
        "perTx": [],
        "flags": {},
        "receivedAt": rfc3339(now_ms()),
        "provider": cards.crypto.seal_json(CardKind::CardEvents.as_str(), &key, &provider),
    });
    let _ = (card, merchant_hash);
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
    {
        Ok(CardPut::Written(_)) => Ok(()),
        // An events webhook created it first (out-of-order delivery): fine.
        Ok(CardPut::Conflict(Some(_))) => Ok(()),
        _ => Err(()),
    }
}

async fn evaluate(
    cards: &Arc<CardsConnector>,
    request: &AsaRequest,
    card: &StoredCardRecord,
    card_id: &str,
    owner: &str,
    merchant_hash: &[u8; 32],
    deadline: Instant,
) -> Decision {
    if request.currency != "USD" {
        return Decision::decline(UNAUTHORIZED_MERCHANT, "declined", "merchant_not_allowed");
    }
    if request.cash_cents > 0 {
        return Decision::decline(UNAUTHORIZED_MERCHANT, "declined", "merchant_not_allowed");
    }
    let mut attestation = cards.attestation().await;
    if !attestation.permits_approval(cards.config.attestation_mode, now_ms())
        && cards.config.attestation_mode == super::tee::AttestationMode::Enforce
        && attestation.hardware != "failed"
        && attestation.measurements != "mismatch"
    {
        // Cold start or a stale check (not a failed one): attest now, inside a
        // bounded slice of the ASA budget, instead of declining every first
        // authorization after a deploy. A failure or timeout still declines.
        let slice = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(900));
        if let Ok(fresh) = tokio::time::timeout(slice, cards.refresh_attestation()).await {
            attestation = fresh;
        }
    }
    if !attestation.permits_approval(cards.config.attestation_mode, now_ms()) {
        return Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal");
    }
    let Some(policy) = card.record["policyPda"]
        .as_str()
        .and_then(|v| v.parse::<solana_address::Address>().ok())
    else {
        return Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal");
    };
    let Some(period) = card.record["periodPda"]
        .as_str()
        .and_then(|v| v.parse::<solana_address::Address>().ok())
    else {
        return Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal");
    };
    // Every approval must come from a ChainPay-opened checkout intent.
    let Some(intent) =
        find_intent(cards, owner, card_id, merchant_hash, request.amount_cents).await
    else {
        return Decision::decline(UNAUTHORIZED_MERCHANT, "declined", "intent_missing");
    };
    let Some(intent_id) = intent.record["intentId"]
        .as_str()
        .and_then(program::unhex::<16>)
    else {
        return Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal");
    };
    let intent_hex = program::hex(&intent_id);
    if request.amount_cents == 0 {
        // $0 account verification never goes through `authorize`
        // (program `InvalidAmount`); approve only while the card is live.
        return match cards
            .per
            .read(&policy, deadline.saturating_duration_since(Instant::now()))
            .await
        {
            TeeRead::Visible { data, .. } => match program::decode_policy(&data) {
                Ok(p)
                    if !p.frozen && p.recovery_state == 0 && p.authorizer == cards.authorizer() =>
                {
                    Decision {
                        result: super::asa::APPROVED,
                        state: "account_verification",
                        reason: None,
                        program_error: None,
                        signature: None,
                        intent_id: Some(intent_hex),
                        reserved_cents: 0,
                    }
                }
                Ok(_) => Decision::decline(CARD_PAUSED, "declined", "frozen"),
                Err(_) => Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal"),
            },
            _ => Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal"),
        };
    }
    let single_message = request.status == "FINANCIAL_AUTHORIZATION";
    let auth_id = program::auth_id_hash(cards.config.issuer_code, &request.token);
    let instruction = program::authorize(
        &cards.authorizer(),
        &policy,
        &period,
        &program::AuthorizeArgs {
            auth_id_hash: auth_id,
            intent_id,
            amount_cents: request.amount_cents,
            merchant_id_hash: *merchant_hash,
            mcc: request.mcc,
            merchant_initiated: request.merchant_initiated,
            single_message,
        },
    );
    let outcome = cards.per.submit(vec![instruction], deadline).await;
    let reservation = program::reservation_pda(&policy, &auth_id);
    let mut decision = match &outcome {
        TxOutcome::Confirmed { .. } => {
            observe(
                cards,
                &reservation,
                request.amount_cents,
                single_message,
                deadline,
            )
            .await
        }
        TxOutcome::ProgramError { code, .. }
            if program::error_name(*code) == Some("DuplicateAuthorization") =>
        {
            // Replay of a token we already authorized: same answer, if amounts agree.
            match observe(
                cards,
                &reservation,
                request.amount_cents,
                single_message,
                deadline,
            )
            .await
            {
                d if d.result == APPROVED => d,
                _ => Decision::decline(SUSPECTED_FRAUD, "ambiguous", "internal"),
            }
        }
        TxOutcome::ProgramError { code, .. } => Decision {
            program_error: program::error_name(*code),
            ..Decision::decline(
                program::asa_result_for(*code),
                "declined",
                program::decline_reason_for(*code),
            )
        },
        TxOutcome::Failed { .. } => {
            Decision::decline(SUSPECTED_FRAUD, "declined_internal", "internal")
        }
        TxOutcome::Unknown { .. } => Decision::decline(SUSPECTED_FRAUD, "ambiguous", "internal"),
    };
    decision.signature = outcome.signature().map(str::to_owned);
    decision.intent_id = Some(intent_hex);
    decision
}

/// Approve only after the Reservation PDA is visible to the authorizer with
/// the expected state and amount. Not seen by the deadline → ambiguous.
async fn observe(
    cards: &CardsConnector,
    reservation: &solana_address::Address,
    amount: u64,
    single_message: bool,
    deadline: Instant,
) -> Decision {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Decision::decline(SUSPECTED_FRAUD, "ambiguous", "internal");
        }
        if let TeeRead::Visible { data, .. } = cards.per.read(reservation, remaining).await {
            return match program::decode_reservation(&data) {
                Ok(r)
                    if !single_message
                        && r.state == reservation_state::RESERVED
                        && r.amount_reserved_cents == amount =>
                {
                    Decision {
                        result: APPROVED,
                        state: "reserved",
                        reason: None,
                        program_error: None,
                        signature: None,
                        intent_id: None,
                        reserved_cents: amount,
                    }
                }
                Ok(r)
                    if single_message
                        && r.state == reservation_state::CAPTURED
                        && r.captured_cents == amount =>
                {
                    Decision {
                        result: APPROVED,
                        state: "captured",
                        reason: None,
                        program_error: None,
                        signature: None,
                        intent_id: None,
                        reserved_cents: 0,
                    }
                }
                // Visible but not what we asked for: never approve.
                _ => Decision::decline(SUSPECTED_FRAUD, "ambiguous", "internal"),
            };
        }
        let pause =
            Duration::from_millis(40).min(deadline.saturating_duration_since(Instant::now()));
        if pause.is_zero() {
            return Decision::decline(SUSPECTED_FRAUD, "ambiguous", "internal");
        }
        tokio::time::sleep(pause).await;
    }
}

/// Index reference that finds a card's open intents for one merchant. The
/// merchant part is blinded: a plain `sha256(acceptor id)` would let a reader
/// of Convex confirm which shops a card may use (an allowlist member).
pub fn match_reference(cards: &CardsConnector, card_id: &str, merchant_hash: &[u8; 32]) -> String {
    format!(
        "match:{card_id}:{}",
        &cards.crypto.blind("intent-match", merchant_hash)[..48]
    )
}

/// Newest open, unexpired intent for this card + merchant (+ USD) whose
/// maximum covers the amount, falling back to the newest open one so the
/// program can give the precise rejection.
pub async fn find_intent(
    cards: &CardsConnector,
    owner: &str,
    card_id: &str,
    merchant_hash: &[u8; 32],
    amount: u64,
) -> Option<StoredCardRecord> {
    let rows = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardEvents,
            owner,
            CONNECTOR,
            &match_reference(cards, card_id, merchant_hash),
            None,
            20,
        )
        .await
        .ok()?;
    let now_secs = (now_ms() / 1000) as i64;
    let open: Vec<StoredCardRecord> = rows
        .into_iter()
        .filter(|row| {
            matches!(row.record["state"].as_str(), Some("open" | "redeemed"))
                && row.record["expiresAtSecs"]
                    .as_i64()
                    .is_some_and(|e| e > now_secs)
                && row.record["currency"] == "USD"
        })
        .collect();
    let max_of = |row: &StoredCardRecord| {
        row.record["maxAmountCents"]
            .as_str()
            .and_then(super::parse_cents)
            .unwrap_or(0)
    };
    // Tightest covering intent (newest first among equals), so a small
    // purchase never consumes the intent opened for a larger one.
    open.iter()
        .filter(|row| max_of(row) >= amount)
        .min_by_key(|row| max_of(row))
        .or_else(|| open.first())
        .cloned()
}

async fn persist(
    cards: &Arc<CardsConnector>,
    request: &AsaRequest,
    decision: &Decision,
) -> Result<(), ()> {
    let decided_at = rfc3339(now_ms());
    let updated = cards
        .update_txn(&request.token, |record| {
            if record["state"] != "pending" {
                // An events webhook or reconciliation got there first; keep
                // their state and only attach the decision.
                record["decision"] = json!({"result": decision.result, "reason": decision.reason, "at": decided_at});
                return true;
            }
            record["state"] = json!(decision.state);
            record["decision"] = json!({"result": decision.result, "reason": decision.reason, "programError": decision.program_error, "at": decided_at});
            record["intentId"] = json!(decision.intent_id);
            record["reservedCents"] = json!(cents(decision.reserved_cents));
            if decision.state == "captured" {
                record["capturedCents"] = json!(cents(request.amount_cents));
                record["singleMessage"] = json!(true);
            }
            if let Some(signature) = &decision.signature {
                if let Some(list) = record["perTx"].as_array_mut() {
                    list.push(json!(signature));
                }
            }
            if decision.state == "ambiguous" {
                record["needsReconcile"] = json!(true);
            }
            true
        })
        .await
        .map_err(|_| ())?;
    let Some(updated) = updated else {
        return Err(());
    };
    if decision.state == "ambiguous" {
        cards.metrics.count("asa_timeouts");
    }
    if decision.state == "captured" && updated.record["state"] == "captured" {
        // `authorize` booked a single-message purchase itself: post it after
        // the reply (the reconcile job backfills it if this task is lost).
        {
            let cards = cards.clone();
            let token = request.token.clone();
            let amount = request.amount_cents;
            tokio::spawn(async move {
                let Ok(Some(row)) = cards.txn(&token).await else {
                    return;
                };
                let Some(card_id) = row.record["cardId"].as_str() else {
                    return;
                };
                let Ok(Some(card)) = cards.card(card_id).await else {
                    return;
                };
                let display = super::merchant_display(&cards, &row);
                let id = program::auth_id_hash(cards.config.issuer_code, &token);
                super::statements::record_posting(
                    &cards,
                    &card,
                    &id,
                    "single_message",
                    amount,
                    &display,
                )
                .await;
            });
        }
    }
    // A $0 verification leaves the intent open for the real purchase.
    if decision.result == APPROVED && decision.state != "account_verification" {
        if let Some(intent_id) = &decision.intent_id {
            mark_intent(cards, intent_id, "consumed", Some(&request.token)).await;
        }
    }
    Ok(())
}

pub async fn mark_intent(
    cards: &CardsConnector,
    intent_id: &str,
    state: &str,
    token: Option<&str>,
) {
    let key = format!("intent:{intent_id}");
    for _ in 0..3 {
        let Ok(Some(row)) = cards
            .store
            .get_card_record(CardKind::CardEvents, &key)
            .await
        else {
            return;
        };
        if row.record["state"] == state {
            return;
        }
        let mut record = row.record.clone();
        record["state"] = json!(state);
        if let Some(token) = token {
            record["txn"] = json!(token);
        }
        record["updatedAt"] = json!(rfc3339(now_ms()));
        if matches!(
            cards
                .store
                .put_card_record(
                    CardKind::CardEvents,
                    &key,
                    row.index.clone(),
                    record,
                    Some(row.rev()),
                    updated_now()
                )
                .await,
            Ok(CardPut::Written(_))
        ) {
            return;
        }
    }
}

/// Lithic re-sent a token we already claimed. Same request → same decision
/// (or keep observing while the first invocation finishes); a different
/// request under the same token is declined and flagged.
async fn duplicate(
    cards: &Arc<CardsConnector>,
    request: &AsaRequest,
    card: &StoredCardRecord,
    intent: &Value,
    stored: &Value,
    deadline: Instant,
) -> &'static str {
    if intent != stored {
        let _ = cards
            .update_txn(&request.token, |record| {
                record["needsReview"] = json!(true);
                record["exception"] = json!("conflicting_duplicate");
                true
            })
            .await;
        return SUSPECTED_FRAUD;
    }
    let policy = card.record["policyPda"]
        .as_str()
        .and_then(|v| v.parse::<solana_address::Address>().ok());
    loop {
        if let Ok(Some(row)) = cards.txn(&request.token).await {
            if let Some(result) = row.record["decision"]["result"].as_str() {
                return static_result(result);
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Some(policy) = &policy {
            let reservation = program::reservation_pda(
                policy,
                &program::auth_id_hash(cards.config.issuer_code, &request.token),
            );
            let single = request.status == "FINANCIAL_AUTHORIZATION";
            if let TeeRead::Visible { data, .. } = cards.per.read(&reservation, remaining).await {
                if let Ok(r) = program::decode_reservation(&data) {
                    let expected = if single {
                        r.captured_cents
                    } else {
                        r.amount_reserved_cents
                    };
                    if expected == request.amount_cents
                        && matches!(
                            r.state,
                            reservation_state::RESERVED | reservation_state::CAPTURED
                        )
                    {
                        return APPROVED;
                    }
                }
            }
        }
        tokio::time::sleep(
            Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }
    // Declining while the first invocation may still approve: reconciliation
    // compares the final state with what the issuer recorded.
    let _ = cards
        .update_txn(&request.token, |record| {
            record["needsReconcile"] = json!(true);
            record["duplicateDeclined"] = json!(true);
            true
        })
        .await;
    SUSPECTED_FRAUD
}

fn static_result(value: &str) -> &'static str {
    match value {
        APPROVED => APPROVED,
        CARD_PAUSED => CARD_PAUSED,
        UNAUTHORIZED_MERCHANT => UNAUTHORIZED_MERCHANT,
        INSUFFICIENT_FUNDS => INSUFFICIENT_FUNDS,
        "VELOCITY_EXCEEDED" => "VELOCITY_EXCEEDED",
        _ => SUSPECTED_FRAUD,
    }
}
