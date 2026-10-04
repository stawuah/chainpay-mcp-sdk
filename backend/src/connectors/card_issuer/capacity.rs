//! Card capacity: give ER rent back to the card prefund once a Reservation or
//! a CheckoutIntent can no longer change (contracts.md Changelog, final fixes).
//!
//! Without this every authorization parked rent for good and a card stopped
//! after ~136 authorizations live (5,000,000 lamports of prefund).
//!
//! - **Reservations** close through `close_reservation` once PER shows them
//!   final (captured in full, reversed or expired; nothing held; no open
//!   dispute) **and** the issuer shows the transaction final (`SETTLED`,
//!   `VOIDED`, `EXPIRED`, `DECLINED`). Called after every applied event pass
//!   and from the reconcile cron.
//! - **Intents** close once consumed, or once expired unused.
//!
//! Replay protection after a close: the program moves the auth id into the
//! card's AuthGuard ring in the same instruction, so `authorize` keeps
//! answering `DuplicateAuthorization` for the next `GUARD_RING` closes on the
//! card. The durable outer guard is Axum's own: the ASA claims
//! `card-asa:v1:<token>` in `operation_claims` (never deleted) and the
//! `asa:<token>` row before anything reaches PER, so a replayed token never
//! gets a second `authorize`.

use super::program::{self, ACCOUNT_NOT_INITIALIZED};
use super::tee::{TeeRead, TxOutcome};
use super::{CONNECTOR, CardsConnector, MERCHANTS, now_ms, rfc3339};
use crate::storage::{CardKind, StoredCardRecord};
use serde_json::{Value, json};
use solana_address::Address;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Issuer statuses after which the transaction moves no more holds.
const ISSUER_FINAL: [&str; 4] = ["SETTLED", "VOIDED", "EXPIRED", "DECLINED"];

/// Unused intents are closed this long after their expiry (PER clock skew).
const INTENT_CLOSE_GRACE_SECS: u64 = 60;

/// Rows scanned per page; pages per card per cron pass. The pass resumes
/// from a cursor stored on the card row and wraps around, so every row is
/// visited eventually however busy the card is.
const SWEEP_PAGE: u32 = 100;
const SWEEP_PAGES: usize = 5;

/// After PER refused a close as not final, leave the row alone this long
/// (an event pass that changes it clears the mark at once).
const NOT_FINAL_BACKOFF_MS: u64 = 3_600_000;

/// AuthGuard layout (card_policy `state::guard_bytes`): disc 8, policy 32,
/// closed_count 8, closed_head 32, then the ring of 32-byte auth ids.
const GUARD_RING_OFFSET: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseOutcome {
    Closed {
        signature: String,
    },
    /// An earlier attempt already closed it (PER no longer has the account).
    AlreadyClosed,
    /// PER or the issuer still say it can move; try again later.
    NotFinal,
    /// Outcome unknown or the rollup is unavailable; the cron retries.
    Pending,
}

/// `true` when the transaction row describes a final hold the program will
/// accept in `close_reservation`, and the issuer agrees.
pub fn closable(record: &Value) -> bool {
    program_final(record) && issuer_final(record)
}

/// The PER side of `closable`: a final hold of ours, not closed yet, and not
/// recently refused by the program.
pub fn program_final(record: &Value) -> bool {
    let state_final = matches!(
        record["state"].as_str(),
        Some("captured" | "reversed" | "expired")
    );
    let nothing_held = record["reservedCents"].as_str().unwrap_or("0") == "0";
    let no_open_dispute = record["disputeState"].as_u64().unwrap_or(0) != 1;
    let backing_off = record["closeNotFinalAtMs"]
        .as_u64()
        .is_some_and(|at| now_ms().saturating_sub(at) < NOT_FINAL_BACKOFF_MS);
    state_final
        && nothing_held
        && no_open_dispute
        && super::events::has_reservation(record)
        && !is_closed(record)
        && !backing_off
}

fn issuer_final(record: &Value) -> bool {
    record["issuerStatus"]
        .as_str()
        .is_some_and(|s| ISSUER_FINAL.contains(&s))
}

pub fn is_closed(record: &Value) -> bool {
    record["reservationClosed"].as_bool() == Some(true)
}

fn card_pdas(card: &StoredCardRecord) -> Option<(Address, Address)> {
    Some((
        card.record["policyPda"].as_str()?.parse().ok()?,
        card.record["periodPda"].as_str()?.parse().ok()?,
    ))
}

/// Send `close_reservation` for the transaction `token` and record the result
/// on its row. Idempotent: a retry after a lost confirmation finds the account
/// gone and records `AlreadyClosed`.
pub async fn close_reservation(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    token: &str,
) -> CloseOutcome {
    let Some((policy, period)) = card_pdas(card) else {
        return CloseOutcome::Pending;
    };
    let auth_id = program::auth_id_hash(cards.config.issuer_code, token);
    let outcome = cards
        .per
        .submit(
            vec![program::close_reservation(
                &cards.authorizer(),
                &policy,
                &period,
                &auth_id,
            )],
            Instant::now() + Duration::from_secs(8),
        )
        .await;
    let result = match outcome {
        TxOutcome::Confirmed { signature } => CloseOutcome::Closed { signature },
        TxOutcome::ProgramError { code, .. }
            if program::error_name(code) == Some("ReservationNotFinal") =>
        {
            CloseOutcome::NotFinal
        }
        TxOutcome::ProgramError { code, .. } if code == ACCOUNT_NOT_INITIALIZED => {
            if gone(cards, &policy, &auth_id).await {
                CloseOutcome::AlreadyClosed
            } else {
                CloseOutcome::Pending
            }
        }
        _ => CloseOutcome::Pending,
    };
    match &result {
        CloseOutcome::Closed { .. } | CloseOutcome::AlreadyClosed => {
            mark_closed(cards, token, &result).await;
            cards.metrics.count("reservations_closed");
        }
        CloseOutcome::NotFinal => {
            // The row says final, PER disagrees: back off until an event
            // pass refreshes the row (it clears the mark).
            let at = now_ms();
            let _ = cards
                .update_txn(token, |record| {
                    record["closeNotFinalAtMs"] = json!(at);
                    true
                })
                .await;
        }
        CloseOutcome::Pending => {}
    }
    result
}

/// The authorizer is a member of every card account, so `null` for its own
/// Reservation means the account no longer exists.
pub async fn gone(cards: &CardsConnector, policy: &Address, auth_id: &[u8; 32]) -> bool {
    matches!(
        cards
            .per
            .read(
                &program::reservation_pda(policy, auth_id),
                Duration::from_secs(4)
            )
            .await,
        TeeRead::NotVisible { .. }
    )
}

/// `true` only when the card's AuthGuard ring holds this auth id, i.e. the
/// program closed its Reservation. A read that fails or has not caught up is
/// `false` (never a guess).
pub async fn closed_on_chain(
    cards: &CardsConnector,
    policy: &Address,
    auth_id: &[u8; 32],
    deadline: Instant,
) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    match cards
        .per
        .read(&program::auth_guard_pda(policy), remaining)
        .await
    {
        TeeRead::Visible { data, .. } => guard_contains(&data, auth_id),
        _ => false,
    }
}

pub fn guard_contains(data: &[u8], auth_id: &[u8; 32]) -> bool {
    let end = GUARD_RING_OFFSET + 32 * program::GUARD_RING as usize;
    data.get(GUARD_RING_OFFSET..end)
        .is_some_and(|ring| ring.chunks_exact(32).any(|slot| slot == auth_id))
}

pub async fn mark_closed(cards: &CardsConnector, token: &str, outcome: &CloseOutcome) {
    let signature = match outcome {
        CloseOutcome::Closed { signature } => Some(signature.clone()),
        _ => None,
    };
    let at = rfc3339(now_ms());
    let _ = cards
        .update_txn(token, |record| {
            if is_closed(record) {
                return false;
            }
            record["reservationClosed"] = json!(true);
            record["reservationClosedAt"] = json!(at);
            if let (Some(signature), Some(list)) = (&signature, record["perTx"].as_array_mut()) {
                list.push(json!(signature));
            }
            true
        })
        .await;
}

/// Cron sweep for one card: close final reservations and dead intents that
/// the event path missed (crash, lost confirmation, events older than the
/// reconcile window). Bounded per pass, resumable across passes.
pub async fn sweep_card(cards: &Arc<CardsConnector>, card: &StoredCardRecord, deadline: Instant) {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    let mut before: Option<String> = card.record["capacitySweepBefore"]
        .as_str()
        .map(str::to_owned);
    let mut finished = false;
    for _ in 0..SWEEP_PAGES {
        if Instant::now() > deadline {
            break;
        }
        let Ok(rows) = cards
            .store
            .list_card_records_for_owner(
                CardKind::CardEvents,
                &owner,
                CONNECTOR,
                &card_id,
                before.as_deref(),
                SWEEP_PAGE,
            )
            .await
        else {
            return;
        };
        let full = rows.len() == SWEEP_PAGE as usize;
        let mut last = before.clone();
        for row in rows {
            if Instant::now() > deadline {
                break;
            }
            last = Some(row.updated.clone());
            if let Some(token) = row.key.strip_prefix("asa:") {
                sweep_reservation(cards, card, token, &row.record).await;
            }
        }
        before = last;
        if !full {
            finished = true;
            break;
        }
    }
    // Resume from here next pass; start over once the oldest row was seen.
    let cursor = if finished { None } else { before };
    if card.record["capacitySweepBefore"].as_str() != cursor.as_deref() {
        let _ = cards
            .update_card(&card_id, |record| {
                record["capacitySweepBefore"] = json!(cursor);
            })
            .await;
    }
    sweep_intents(cards, card, &owner, &card_id, deadline).await;
}

async fn sweep_reservation(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    token: &str,
    record: &Value,
) {
    if closable(record) {
        close_reservation(cards, card, token).await;
        return;
    }
    if !program_final(record) {
        return;
    }
    // PER is final but the row last saw a live issuer status: ask the issuer
    // (rare: statuses move with their events).
    let Ok(truth) = cards.lithic.get_transaction(token).await else {
        return;
    };
    let status = truth["status"].clone();
    let mut fresh = record.clone();
    fresh["issuerStatus"] = status.clone();
    if closable(&fresh) {
        let _ = cards
            .update_txn(token, |current| {
                current["issuerStatus"] = status.clone();
                true
            })
            .await;
        close_reservation(cards, card, token).await;
    }
}

/// Consumed intents, and unused intents past their expiry, for each fixture
/// merchant (intents can only be opened for registry merchants), page by page.
async fn sweep_intents(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    owner: &str,
    card_id: &str,
    deadline: Instant,
) {
    let Some((policy, _)) = card_pdas(card) else {
        return;
    };
    let now_secs = now_ms() / 1000;
    for merchant in MERCHANTS.iter() {
        let reference = super::asa::match_reference(
            cards,
            card_id,
            &program::merchant_id_hash(merchant.acceptor_id),
        );
        let mut before: Option<String> = None;
        for _ in 0..SWEEP_PAGES {
            if Instant::now() > deadline {
                return;
            }
            let Ok(rows) = cards
                .store
                .list_card_records_for_owner(
                    CardKind::CardEvents,
                    owner,
                    CONNECTOR,
                    &reference,
                    before.as_deref(),
                    SWEEP_PAGE,
                )
                .await
            else {
                break;
            };
            let full = rows.len() == SWEEP_PAGE as usize;
            before = rows.last().map(|row| row.updated.clone());
            for row in rows {
                if Instant::now() > deadline {
                    return;
                }
                if intent_closable(&row.record, now_secs) {
                    if let Some(intent_id) = row.record["intentId"].as_str() {
                        let state = if row.record["state"] == "consumed" {
                            "closed"
                        } else {
                            "expired_closed"
                        };
                        close_intent(cards, &policy, intent_id, state).await;
                    }
                }
            }
            if !full {
                break;
            }
        }
    }
}

pub fn intent_closable(record: &Value, now_secs: u64) -> bool {
    match record["state"].as_str() {
        Some("consumed") => true,
        Some("open" | "redeemed") => record["expiresAtSecs"]
            .as_u64()
            .is_some_and(|e| now_secs > e.saturating_add(INTENT_CLOSE_GRACE_SECS)),
        _ => false,
    }
}

/// Close one intent (and its permission) on PER and record `state` on its
/// row. Shared by the ASA (right after a consumed intent's reply) and the
/// cron. An intent already gone counts as closed.
pub async fn close_intent(
    cards: &Arc<CardsConnector>,
    policy: &Address,
    intent_id: &str,
    state: &str,
) {
    let Some(id) = program::unhex::<16>(intent_id) else {
        return;
    };
    let intent = program::intent_pda(policy, &id);
    let outcome = cards
        .per
        .submit(
            vec![program::close_checkout_intent(
                &cards.authorizer(),
                policy,
                &intent,
            )],
            Instant::now() + Duration::from_secs(8),
        )
        .await;
    let closed = match outcome {
        TxOutcome::Confirmed { .. } => true,
        TxOutcome::ProgramError { code, .. } if code == ACCOUNT_NOT_INITIALIZED => matches!(
            cards.per.read(&intent, Duration::from_secs(4)).await,
            TeeRead::NotVisible { .. }
        ),
        _ => false,
    };
    if closed {
        super::asa::mark_intent(cards, intent_id, state, None).await;
        cards.metrics.count("intents_closed");
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn only_final_holds_the_issuer_also_finished_are_closable() {
        let base = json!({"state": "captured", "reservedCents": "0", "disputeState": 0, "issuerStatus": "SETTLED", "hasReservation": true});
        assert!(closable(&base));
        for (field, value) in [
            ("state", json!("partially_captured")),
            ("state", json!("reserved")),
            ("reservedCents", json!("10")),
            ("disputeState", json!(1)),
            ("issuerStatus", json!("PENDING")),
            ("reservationClosed", json!(true)),
            ("closeNotFinalAtMs", json!(now_ms())),
        ] {
            let mut record = base.clone();
            record[field] = value;
            assert!(!closable(&record), "{field} must block the close");
        }
        let mut reversed = base.clone();
        reversed["state"] = json!("reversed");
        reversed["issuerStatus"] = json!("VOIDED");
        assert!(closable(&reversed));
        // A dispute that was decided no longer blocks.
        let mut won = base.clone();
        won["disputeState"] = json!(2);
        assert!(closable(&won));
        // An old not-final mark has expired.
        let mut old = base.clone();
        old["closeNotFinalAtMs"] = json!(1);
        assert!(closable(&old));
    }

    #[test]
    fn intents_close_when_consumed_or_well_past_expiry() {
        assert!(intent_closable(&json!({"state": "consumed"}), 0));
        assert!(!intent_closable(&json!({"state": "closed"}), 0));
        let open = json!({"state": "open", "expiresAtSecs": 1_000});
        assert!(!intent_closable(&open, 1_000 + INTENT_CLOSE_GRACE_SECS));
        assert!(intent_closable(&open, 1_001 + INTENT_CLOSE_GRACE_SECS));
    }

    #[test]
    fn guard_ring_lookup_reads_only_the_ring() {
        let mut data = vec![0u8; GUARD_RING_OFFSET + 32 * program::GUARD_RING as usize + 8];
        let id = [7u8; 32];
        assert!(!guard_contains(&data, &id));
        data[GUARD_RING_OFFSET + 32 * 255..GUARD_RING_OFFSET + 32 * 256].copy_from_slice(&id);
        assert!(guard_contains(&data, &id));
        // The same bytes in the header (closed_head) do not count.
        let mut header = vec![0u8; data.len()];
        header[48..80].copy_from_slice(&id);
        assert!(!guard_contains(&header, &id));
        assert!(!guard_contains(&data[..100], &id), "short account");
    }
}
