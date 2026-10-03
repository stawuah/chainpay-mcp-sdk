//! `/internal/cron/cards/reconcile` (Vercel Cron → Axum; contracts.md §3.4,
//! §4.1, §8). Bounded, resumable, safe to run concurrently with webhooks:
//!
//! 1. drain pending inbox rows (events that could not be applied inline);
//! 2. for a page of cards: pull issuer truth since the last pass, apply any
//!    transaction ChainPay never saw (pairs captures with authorizations and
//!    flags captures with no authorization), resolve `ambiguous` and stale
//!    `pending` decisions from PER + issuer truth, and re-drive issuer
//!    freezes still waiting for acknowledgement.
//!
//! `ambiguous` is never released on a timer: only evidence moves it.

use super::program::{self, reservation_state};
use super::tee::{TeeRead, TxOutcome};
use super::{CardsConnector, cents, log_id, now_ms, rfc3339, updated_now};
use crate::storage::{CardIndex, CardKind, CardPut, StoredCardRecord};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

const STALE_PENDING_MS: u64 = 15_000;
const CURSOR_KEY: &str = "cron:cursor";

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub processed: u32,
    pub remaining: u32,
    pub inbox_applied: u32,
    pub ambiguous_resolved: u32,
    pub unpaired_flagged: u32,
    pub freezes_confirmed: u32,
    pub errors: u32,
}

fn issuer_approved(truth: &Value) -> bool {
    truth["result"].as_str() == Some("APPROVED")
        || truth["events"].as_array().is_some_and(|events| {
            events.iter().any(|e| {
                matches!(
                    e["type"].as_str(),
                    Some("AUTHORIZATION" | "FINANCIAL_AUTHORIZATION")
                ) && e["result"].as_str() == Some("APPROVED")
            })
        })
}

/// Resolve an `ambiguous` (or stale `pending`) authorization (contracts.md §4.1):
/// - PER Reservation + issuer approved → `reserved` (it really was approved);
/// - PER Reservation + issuer declined → authorizer `reverse(void)` → `reversed`;
/// - no Reservation → `declined` (any later capture is a flagged exception).
pub async fn resolve_ambiguous(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
    truth: &Value,
) -> Result<(), String> {
    let token = truth["token"].as_str().ok_or("no token")?.to_owned();
    let policy: solana_address::Address = card.record["policyPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or("card accounts")?;
    let period: solana_address::Address = card.record["periodPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or("card accounts")?;
    // Visibility sanity: if the authorizer cannot see the policy, `null` for
    // the reservation proves nothing. Fail closed (stale_per_read).
    if !matches!(
        cards.per.read(&policy, Duration::from_secs(4)).await,
        TeeRead::Visible { .. }
    ) {
        super::card_log!(
            "stale_per_read card {}",
            log_id(card.record["cardId"].as_str().unwrap_or(""))
        );
        return Err("policy not visible to the authorizer".into());
    }
    let reservation = program::reservation_pda(
        &policy,
        &program::auth_id_hash(cards.config.issuer_code, &token),
    );
    let approved = issuer_approved(truth);
    let read = cards.per.read(&reservation, Duration::from_secs(4)).await;
    let (state, signature, has_reservation) = match read {
        TeeRead::Visible { data, .. } => {
            let r = program::decode_reservation(&data).map_err(|_| "reservation undecodable")?;
            if approved {
                let state = match r.state {
                    reservation_state::CAPTURED => "captured",
                    reservation_state::PARTIALLY_CAPTURED => "partially_captured",
                    reservation_state::REVERSED => "reversed",
                    reservation_state::EXPIRED => "expired",
                    _ => "reserved",
                };
                (state, None, true)
            } else if r.amount_reserved_cents == 0
                || matches!(
                    r.state,
                    reservation_state::REVERSED | reservation_state::EXPIRED
                )
            {
                ("reversed", None, true)
            } else {
                // A reservation exists but the issuer declined: release it.
                let id = program::event_id_hash(
                    cards.config.issuer_code,
                    &format!("ambiguous-void:{token}"),
                );
                let instruction = program::reverse(
                    &cards.authorizer(),
                    &policy,
                    &period,
                    &reservation,
                    r.amount_reserved_cents,
                    0,
                    &id,
                );
                match cards
                    .per
                    .submit(vec![instruction], Instant::now() + Duration::from_secs(6))
                    .await
                {
                    TxOutcome::Confirmed { signature } => ("reversed", Some(signature), true),
                    TxOutcome::ProgramError { code, .. }
                        if matches!(
                            program::error_name(code),
                            Some("DuplicateEvent" | "ReservationClosed")
                        ) =>
                    {
                        ("reversed", None, true)
                    }
                    _ => return Err("void of ambiguous reservation not confirmed".into()),
                }
            }
        }
        TeeRead::NotVisible { .. } => ("declined", None, false),
        TeeRead::RpcError(_) => return Err("PER read failed".into()),
    };
    // PER is the source of truth for the money fields (after any void).
    let mut money = json!({});
    if has_reservation {
        super::events::refresh_from_reservation(cards, &mut money, &reservation).await;
    }
    let at = rfc3339(now_ms());
    cards
        .update_txn(&token, |record| {
            if !matches!(record["state"].as_str(), Some("ambiguous" | "pending")) {
                return false;
            }
            record["state"] = json!(state);
            record["hasReservation"] = json!(has_reservation);
            record["needsReconcile"] = json!(false);
            record["resolvedAt"] = json!(at);
            record["resolution"] =
                json!({"issuerApproved": approved, "reservationSeen": has_reservation});
            if !has_reservation && approved {
                // Issuer approved something we never reserved: later captures
                // post as exceptions, never as approved spend.
                record["unsolicited"] = json!(true);
                record["needsReview"] = json!(true);
                record["exception"] = json!("unpaired_authorization");
            }
            for field in [
                "reservedCents",
                "capturedCents",
                "reversedCents",
                "refundedCents",
            ] {
                if !money[field].is_null() {
                    record[field] = money[field].clone();
                }
            }
            if let (Some(signature), Some(list)) = (&signature, record["perTx"].as_array_mut()) {
                list.push(json!(signature));
            }
            true
        })
        .await
        .map_err(|_| "storage")?;
    let _ = row;
    Ok(())
}

async fn cursor(cards: &CardsConnector) -> (Option<StoredCardRecord>, Option<String>) {
    let row = cards
        .store
        .get_card_record(CardKind::CardRecovery, CURSOR_KEY)
        .await
        .ok()
        .flatten();
    let after = row
        .as_ref()
        .and_then(|r| r.record["after"].as_str().map(str::to_owned));
    (row, after)
}

async fn save_cursor(
    cards: &CardsConnector,
    current: Option<StoredCardRecord>,
    after: Option<String>,
) {
    let record = json!({"v": 1, "type": "cursor", "after": after, "at": rfc3339(now_ms())});
    let _ = cards
        .store
        .put_card_record(
            CardKind::CardRecovery,
            CURSOR_KEY,
            CardIndex::default(),
            record,
            current.map(|r| r.rev()),
            updated_now(),
        )
        .await;
}

pub async fn run(cards: &Arc<CardsConnector>, budget: Duration) -> ReconcileReport {
    let started = Instant::now();
    let mut report = ReconcileReport::default();
    cards.per.warm().await;
    if now_ms().saturating_sub(cards.attestation().await.checked_at_ms) > 10 * 60 * 1000 {
        let _ = tokio::time::timeout(Duration::from_secs(20), cards.refresh_attestation()).await;
    }
    // 1. Inbox: walk the whole pending queue, page by page, within budget.
    let inbox = super::events::inbox(cards);
    let mut before: Option<String> = None;
    loop {
        let page = inbox
            .pending_page(before.as_deref(), 25)
            .await
            .unwrap_or_default();
        if page.is_empty() {
            break;
        }
        before = page.last().map(|row| row.updated.clone());
        let full = page.len() == 25;
        for row in page {
            if started.elapsed() > budget {
                report.remaining += 1;
                continue;
            }
            report.processed += 1;
            if super::events::process_inbox_row(cards, &row).await
                == crate::connectors::inbox::InboxOutcome::Applied
            {
                report.inbox_applied += 1;
            }
        }
        if !full || started.elapsed() > budget {
            break;
        }
    }
    // 2. Cards, one bounded page per run, resuming from a stored cursor.
    let (cursor_row, after) = cursor(cards).await;
    let page = cards
        .store
        .scan_card_records(CardKind::Cards, "card:", after.as_deref(), 10)
        .await
        .unwrap_or_default();
    let mut last = after.clone();
    for card in &page {
        if started.elapsed() > budget {
            report.remaining += 1;
            continue;
        }
        report.processed += 1;
        reconcile_card(cards, card, &mut report).await;
        last = Some(card.key.clone());
    }
    // Wrap around once the page runs out.
    let next = if page.len() < 10 { None } else { last };
    save_cursor(cards, cursor_row, next).await;
    report
}

async fn reconcile_card(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    report: &mut ReconcileReport,
) {
    let Some(issuer) = cards.card_issuer(card) else {
        return;
    };
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    // Issuer truth since the last pass (with overlap), to find transactions
    // whose webhooks never arrived (including force posts).
    let since = card.record["reconciledThroughSecs"]
        .as_u64()
        .map(|secs| rfc3339(secs.saturating_sub(3_600) * 1000));
    // Advance the window only after a complete, successful listing.
    let (truths, complete) = match cards
        .lithic
        .list_transactions(&issuer.card_token, since.as_deref())
        .await
    {
        Ok(page) => (page.transactions, page.complete),
        Err(_) => {
            report.errors += 1;
            (Vec::new(), false)
        }
    };
    let mut advance = complete;
    for truth in &truths {
        let Some(token) = truth["token"].as_str() else {
            continue;
        };
        let known = cards.txn(token).await.ok().flatten();
        let unseen = known.is_none();
        let stale_pending = known.as_ref().is_some_and(|row| {
            row.record["state"] == "pending"
                && row
                    .updated
                    .parse::<u64>()
                    .map(|u| now_ms().saturating_sub(u / 1000) > STALE_PENDING_MS)
                    .unwrap_or(true)
        });
        if stale_pending {
            if let Some(row) = &known {
                let _ = cards
                    .update_txn(token, |record| {
                        if record["state"] != "pending" {
                            return false;
                        }
                        record["state"] = json!("ambiguous");
                        record["needsReconcile"] = json!(true);
                        true
                    })
                    .await;
                let _ = row;
            }
        }
        let needs = unseen
            || stale_pending
            || known.as_ref().is_some_and(|row| {
                row.record["needsReconcile"] == true
                    || row.record["state"] == "ambiguous"
                    || applied_count(&row.record) < truth["events"].as_array().map_or(0, Vec::len)
            });
        if !needs {
            continue;
        }
        let was_ambiguous = known
            .as_ref()
            .is_some_and(|row| row.record["state"] == "ambiguous")
            || stale_pending;
        match super::events::apply_transaction(cards, card, truth).await {
            Ok(()) => {
                if was_ambiguous {
                    report.ambiguous_resolved += 1;
                }
                if unseen
                    && truth["events"]
                        .as_array()
                        .is_some_and(|e| e.iter().any(|e| e["type"] == "CLEARING"))
                {
                    report.unpaired_flagged += 1;
                }
            }
            Err(_) => {
                report.errors += 1;
                // Keep the window: this transaction is retried next pass.
                advance = false;
            }
        }
    }
    // Ambiguous rows the issuer listing did not cover.
    if let Ok(rows) = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardEvents,
            &owner,
            super::CONNECTOR,
            &card_id,
            None,
            100,
        )
        .await
    {
        for row in rows {
            if row.record["state"] != "ambiguous" {
                continue;
            }
            let Some(token) = row.key.strip_prefix("asa:") else {
                continue;
            };
            if let Ok(truth) = cards.lithic.get_transaction(token).await {
                match resolve_ambiguous(cards, card, &row, &truth).await {
                    Ok(()) => report.ambiguous_resolved += 1,
                    Err(_) => report.errors += 1,
                }
            }
        }
    }
    // Issuer freeze still waiting for acknowledgement: re-read and re-drive.
    if card.record["freeze"]["issuer"] == "pending_issuer_confirmation" {
        let wanted = card.record["freeze"]["wantedIssuerState"]
            .as_str()
            .unwrap_or("PAUSED")
            .to_owned();
        let state = match cards.lithic.get_card(&issuer.card_token).await {
            Ok(issued) if issued.state == wanted => Some(issued.state),
            _ => cards
                .lithic
                .set_state(&issuer.card_token, &wanted)
                .await
                .ok()
                .map(|c| c.state),
        };
        if state.as_deref() == Some(wanted.as_str()) {
            let at = rfc3339(now_ms());
            let _ = cards
                .update_card(&card_id, |record| {
                    record["issuerState"] = json!(wanted);
                    record["freeze"]["issuer"] = json!("confirmed");
                    record["freeze"]["ackAt"] = json!(at);
                    record["freeze"]["ackSource"] = json!("reconcile");
                })
                .await;
            report.freezes_confirmed += 1;
        }
    }
    if advance {
        let through = now_ms() / 1000;
        let _ = cards
            .update_card(&card_id, |record| {
                record["reconciledThroughSecs"] = json!(through)
            })
            .await;
    }
}

fn applied_count(record: &Value) -> usize {
    record["appliedEventIds"].as_array().map_or(0, Vec::len)
}

/// Encrypted recovery snapshot of the card's private state (contracts.md §8),
/// debounced to one per minute per card.
pub async fn maybe_snapshot(cards: &CardsConnector, card: &StoredCardRecord) {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let latest = cards.card(&card_id).await.ok().flatten();
    let last = latest
        .as_ref()
        .and_then(|c| c.record["lastSnapshotSecs"].as_u64())
        .unwrap_or(0);
    if now_ms() / 1000 < last + 60 {
        return;
    }
    let _ = snapshot(cards, card).await;
}

pub async fn snapshot(cards: &CardsConnector, card: &StoredCardRecord) -> Result<u64, String> {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    let policy_pda: solana_address::Address = card.record["policyPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or("accounts")?;
    let period_pda: solana_address::Address = card.record["periodPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or("accounts")?;
    let (
        TeeRead::Visible {
            data: policy_data, ..
        },
        TeeRead::Visible {
            data: period_data, ..
        },
    ) = (
        cards.per.read(&policy_pda, Duration::from_secs(4)).await,
        cards.per.read(&period_pda, Duration::from_secs(4)).await,
    )
    else {
        return Err("private state not visible".into());
    };
    let policy = program::decode_policy(&policy_data).map_err(|_| "policy undecodable")?;
    let period = program::decode_period(&period_data).map_err(|_| "period undecodable")?;
    let key = format!("recovery:{card_id}:{:020}", policy.ledger_seq);
    let snapshot = json!({
        "policy": {
            "policyVersion": policy.policy_version,
            "budgetCents": cents(policy.budget_cents),
            "maxPurchaseCents": cents(policy.max_purchase_cents),
            "maxPurchasesPerPeriod": policy.max_purchases_per_period,
            "periodSeconds": policy.period_seconds,
            "merchantIdHashes": policy.merchant_id_hashes.iter().map(|h| program::hex(h)).collect::<Vec<_>>(),
            "mccs": policy.mccs,
            "expiresAt": policy.expires_at,
            "recurringAllowed": policy.recurring_allowed,
            "feeBps": policy.fee_bps,
            "frozen": policy.frozen,
            "statementOutstandingCents": cents(policy.statement_outstanding_cents),
            "exceptionsOpen": policy.exceptions_open,
            "ledgerHead": program::hex(&policy.ledger_head),
            "ledgerSeq": policy.ledger_seq,
            "commitSeq": policy.commit_seq,
        },
        "period": {
            "periodIndex": period.period_index,
            "periodStart": period.period_start,
            "periodEnd": period.period_end,
            "capturedCents": cents(period.captured_cents),
            "reservedCents": cents(period.reserved_cents),
            "refundedCents": cents(period.refunded_cents),
            "purchasesCount": period.purchases_count,
            "exceptionCents": cents(period.exception_cents),
        },
        "takenAt": rfc3339(now_ms()),
    });
    let record = json!({
        "v": 1,
        "type": "snapshot",
        "cardId": card_id,
        "ledgerSeq": policy.ledger_seq,
        "commitSeq": policy.commit_seq,
        "snapshot": cards.crypto.seal_json(CardKind::CardRecovery.as_str(), &key, &snapshot),
    });
    let index = CardIndex {
        owner: Some(owner),
        connector: Some(super::CONNECTOR.into()),
        reference: Some(card_id.clone()),
        idempotency: None,
    };
    match cards
        .store
        .put_card_record(
            CardKind::CardRecovery,
            &key,
            index,
            record,
            None,
            updated_now(),
        )
        .await
    {
        Ok(CardPut::Written(_) | CardPut::Conflict(_)) => {}
        Err(_) => return Err("storage".into()),
    }
    let secs = now_ms() / 1000;
    let seq = policy.ledger_seq;
    let _ = cards
        .update_card(&card_id, |record| {
            record["lastSnapshotSecs"] = json!(secs);
            record["lastSnapshotSeq"] = json!(seq);
        })
        .await;
    Ok(seq)
}
