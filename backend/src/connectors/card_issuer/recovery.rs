//! Recovery (contracts.md §8, PLAN H): lost or stale PER state is detected by
//! the reconcile job, the card is frozen at the issuer at once and
//! `recovery_freeze`d on PER, the owner and the authorizer co-sign `restore`
//! from the encrypted recovery snapshot plus everything ChainPay booked since,
//! issuer events that were never applied are replayed, and only then can the
//! owner confirm. Counters are never reset and the card never resumes on its
//! own: it stays frozen until the owner unfreezes it.

use super::program;
use super::routes::{Caller, CardsError, card_pdas, operation_id, owned_card};
use super::statements;
use super::tee::{TeeRead, TxOutcome};
use super::{CONNECTOR, CardsConnector, cents, log_id, now_ms, parse_cents, rfc3339};
use crate::storage::{CardKind, StoredCardRecord};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Why the authorizer believes the card's private state is lost or stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loss {
    /// The authorizer's own token gets `null` for an activated card (CD-4).
    NotVisible,
    /// PER shows an older ledger than the last recovery snapshot.
    LedgerRegressed,
    /// Same ledger sequence, different head: the history diverged.
    LedgerDiverged,
    /// Attestation `enforce` failed: the enclave is not the one we trust.
    Attestation,
    /// PER already shows `recovery_frozen` (owner or an earlier pass).
    OnChain,
}

impl Loss {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotVisible => "state_not_visible",
            Self::LedgerRegressed => "ledger_regressed",
            Self::LedgerDiverged => "ledger_diverged",
            Self::Attestation => "attestation_failed",
            Self::OnChain => "recovery_frozen_on_chain",
        }
    }
}

/// Compare what PER shows with the last snapshot ChainPay took.
pub fn classify(
    policy: Option<&program::CardPolicyAccount>,
    snapshot_seq: Option<u64>,
    snapshot_head: Option<[u8; 32]>,
) -> Option<Loss> {
    let Some(policy) = policy else {
        return Some(Loss::NotVisible);
    };
    if policy.recovery_state == 1 {
        return Some(Loss::OnChain);
    }
    if let Some(seq) = snapshot_seq {
        if policy.ledger_seq < seq {
            return Some(Loss::LedgerRegressed);
        }
        if policy.ledger_seq == seq && snapshot_head.is_some_and(|h| h != policy.ledger_head) {
            return Some(Loss::LedgerDiverged);
        }
    }
    None
}

async fn latest_snapshot(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Option<(StoredCardRecord, Value)> {
    let owner = card.index.owner.clone().unwrap_or_default();
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let rows = cards
        .store
        .list_card_records_for_owner(CardKind::CardRecovery, &owner, CONNECTOR, card_id, None, 50)
        .await
        .ok()?;
    let latest = rows
        .into_iter()
        .filter(|row| row.record["type"] == "snapshot")
        .max_by_key(|row| row.record["ledgerSeq"].as_u64().unwrap_or(0))?;
    let snapshot = cards
        .crypto
        .open_json(
            CardKind::CardRecovery.as_str(),
            &latest.key,
            &latest.record["snapshot"],
        )
        .ok()?;
    Some((latest, snapshot))
}

/// Local recovery states during which no statement or rollover work may run.
pub fn in_recovery(card: &StoredCardRecord) -> bool {
    matches!(
        card.record["recovery"]["state"].as_str(),
        Some("recovery_frozen" | "restore_prepared" | "reconciled_pending_owner_confirm")
    )
}

/// Reconcile-job step: detect loss and freeze (issuer first, then PER).
/// Returns the loss it acted on, if any.
pub async fn check(cards: &Arc<CardsConnector>, card: &StoredCardRecord) -> Option<Loss> {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // Only cards ChainPay activated: before that, `null` just means "not set up".
    if card.record["mirror"]["state"] != "acknowledged" {
        return None;
    }
    let recovery_state = card.record["recovery"]["state"].as_str().unwrap_or("");
    let (policy_pda, period_pda) = card_pdas(card).ok()?;
    let read = cards.per.read(&policy_pda, Duration::from_secs(4)).await;
    let policy = match &read {
        TeeRead::Visible { data, .. } => Some(program::decode_policy(data).ok()?),
        TeeRead::NotVisible { .. } => None,
        // An outage is not a loss; the ASA path already fails closed.
        TeeRead::RpcError(_) => return None,
    };
    if let Some(policy) = &policy {
        if policy.authorizer != cards.authorizer() {
            return None;
        }
        // The owner confirmed reconciliation on PER (recovery_state back to 0
        // with the very digest the reviewed restore carried): record it. The
        // card stays frozen until the owner unfreezes. Any other way back to
        // 0 (a restore that never landed) falls through to the health checks.
        let reviewed = card.record["recovery"]["reconDigest"]
            .as_str()
            .and_then(program::unhex::<32>);
        if policy.recovery_state == 0
            && recovery_state == "reconciled_pending_owner_confirm"
            && reviewed == Some(policy.recon_digest)
        {
            let at = rfc3339(now_ms());
            let _ = cards
                .update_card(&card_id, |record| {
                    record["recovery"]["state"] = json!("restored");
                    record["recovery"]["confirmedAt"] = json!(at);
                })
                .await;
            return None;
        }
        if policy.recovery_state == 2 {
            return None;
        }
    }
    let enforce_failed = cards.config.attestation_mode == super::tee::AttestationMode::Enforce
        && !cards
            .attestation()
            .await
            .permits_approval(cards.config.attestation_mode, now_ms());
    let snapshot = latest_snapshot(cards, card).await;
    let snapshot_seq = snapshot
        .as_ref()
        .and_then(|(row, _)| row.record["ledgerSeq"].as_u64());
    let snapshot_head = snapshot
        .as_ref()
        .and_then(|(_, s)| s["policy"]["ledgerHead"].as_str())
        .and_then(program::unhex::<32>);
    let loss = classify(policy.as_ref(), snapshot_seq, snapshot_head)
        .or(enforce_failed.then_some(Loss::Attestation))?;
    if policy.is_none() {
        cards.metrics.count("stale_per_reads");
        super::card_log!("stale_per_read card {}", log_id(&card_id));
    }
    let per_frozen = matches!(
        card.record["recovery"]["perRecoveryFreeze"].as_str(),
        Some("confirmed" | "already")
    );
    if matches!(
        recovery_state,
        "recovery_frozen" | "restore_prepared" | "reconciled_pending_owner_confirm"
    ) && (per_frozen || loss == Loss::OnChain || policy.is_none())
    {
        // Already in recovery (and frozen on PER when PER is reachable).
        return Some(loss);
    }
    cards.metrics.count("recovery_detections");
    super::card_log!(
        "recovery detected for card {}: {}",
        log_id(&card_id),
        loss.as_str()
    );
    // 1. Issuer first: this works even when PER is gone.
    let issuer_paused = match cards.card_issuer(card) {
        Some(issuer) => {
            matches!(cards.lithic.set_state(&issuer.card_token, "PAUSED").await, Ok(c) if c.state == "PAUSED")
        }
        None => false,
    };
    // 2. PER `recovery_freeze`, if the rollup will take it.
    let per = if loss == Loss::OnChain {
        "already"
    } else {
        match cards
            .per
            .submit(
                vec![program::recovery_freeze(
                    &cards.authorizer(),
                    &policy_pda,
                    &period_pda,
                    program::FREEZE_RECOVERY,
                )],
                Instant::now() + Duration::from_secs(8),
            )
            .await
        {
            TxOutcome::Confirmed { .. } => {
                cards.metrics.count("recovery_freezes");
                "confirmed"
            }
            TxOutcome::Unknown { .. } => "unknown",
            _ => "failed",
        }
    };
    let at = rfc3339(now_ms());
    let _ = cards
        .update_card(&card_id, |record| {
            record["recovery"] = json!({
                "state": "recovery_frozen",
                "reason": loss.as_str(),
                "detectedAt": at,
                "perRecoveryFreeze": per,
                "snapshotLedgerSeq": snapshot_seq,
            });
            record["freeze"] = json!({
                "onChain": per == "confirmed" || per == "already",
                "issuer": if issuer_paused { "confirmed" } else { "pending_issuer_confirmation" },
                "wantedIssuerState": "PAUSED",
                "at": at,
                "reason": "recovery",
            });
            if issuer_paused {
                record["issuerState"] = json!("PAUSED");
                record["freeze"]["ackAt"] = json!(at);
                record["freeze"]["ackSource"] = json!("patch_200");
            }
        })
        .await;
    Some(loss)
}

/// Recovery numbers: the latest snapshot plus everything ChainPay booked
/// after it (postings, holds still open, approvals, repayments). The owner
/// reviews these exact numbers; they are never zeros and never a reset.
pub async fn restored_numbers(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    snapshot: &Value,
) -> Result<Value, CardsError> {
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let owner = card.index.owner.clone().unwrap_or_default();
    let taken_at = snapshot["takenAt"].as_str().unwrap_or("").to_owned();
    let q = &snapshot["period"];
    let p = &snapshot["policy"];
    let num = |v: &Value| parse_cents(v.as_str().unwrap_or("0")).unwrap_or(0);
    let fee_bps = p["feeBps"].as_u64().unwrap_or(0) as u16;
    let mut captured = num(&q["capturedCents"]);
    let mut refunded = num(&q["refundedCents"]);
    let mut exception = num(&q["exceptionCents"]);
    let mut outstanding = num(&p["statementOutstandingCents"]);
    let mut purchases = q["purchasesCount"].as_u64().unwrap_or(0);
    let mut postings_applied = 0u64;

    // Postings after the snapshot, in posting order: open ones and any a
    // later statement already filed.
    let mut rows = Vec::new();
    for reference in posting_references(card) {
        rows.extend(statements::all_under(cards, CardKind::CardEvents, &owner, &reference).await?);
    }
    rows.retain(|r| {
        r.record["type"] == "posting"
            && r.record["postedAt"]
                .as_str()
                .is_some_and(|t| t > taken_at.as_str())
    });
    rows.sort_by(|a, b| {
        a.record["postedAt"]
            .as_str()
            .cmp(&b.record["postedAt"].as_str())
            .then(a.key.cmp(&b.key))
    });
    for row in &rows {
        let Ok(line) = cards.crypto.open_json::<Value>(
            CardKind::CardEvents.as_str(),
            &row.key,
            &row.record["line"],
        ) else {
            return Err(CardsError::internal());
        };
        let amount = parse_cents(line["amountCents"].as_str().unwrap_or(""))
            .ok_or_else(CardsError::internal)?;
        let bps = line["feeBps"].as_u64().map(|b| b as u16).unwrap_or(fee_bps);
        let gross = amount + statements::fee_cents(amount, bps);
        match line["kind"].as_str() {
            Some("purchase") => {
                captured += amount;
                outstanding += gross;
            }
            Some("adjustment_debit") => {
                captured += amount;
                exception += amount;
                outstanding += gross;
            }
            Some("refund") | Some("adjustment_credit") => {
                refunded += amount;
                outstanding = outstanding.saturating_sub(gross);
            }
            _ => continue,
        }
        postings_applied += 1;
    }
    // Repayments recorded on PER after the snapshot.
    let statements_rows =
        statements::all_under(cards, CardKind::CardStatements, &owner, card_id).await?;
    for s in statements_rows
        .iter()
        .filter(|s| s.record["type"] == "statement" && s.record["state"] == "discharged")
    {
        let discharged_after = s.record["history"].as_array().is_some_and(|h| {
            h.iter().any(|e| {
                e["state"] == "discharged"
                    && e["at"].as_str().is_some_and(|t| t > taken_at.as_str())
            })
        });
        if discharged_after {
            let paid = parse_cents(s.record["discharge"]["amountCents"].as_str().unwrap_or("0"))
                .unwrap_or(0);
            outstanding = outstanding.saturating_sub(paid);
        }
    }
    // Holds and approvals: the transaction rows mirror PER after every event.
    let txns = statements::all_under(cards, CardKind::CardEvents, &owner, card_id).await?;
    let mut reserved = 0u64;
    for row in txns.iter().filter(|r| r.record["type"] == "transaction") {
        if matches!(
            row.record["state"].as_str(),
            Some("reserved" | "partially_captured")
        ) {
            reserved += num(&row.record["reservedCents"]);
        }
        let approved_after = row.record["decision"]["result"] == "APPROVED"
            && row.record["decision"]["at"]
                .as_str()
                .is_some_and(|t| t > taken_at.as_str())
            && row.record["state"] != "account_verification";
        if approved_after {
            purchases += 1;
        }
    }
    Ok(json!({
        "periodIndex": q["periodIndex"],
        "capturedCents": cents(captured),
        "reservedCents": cents(reserved),
        "refundedCents": cents(refunded),
        "exceptionCents": cents(exception),
        "purchasesCount": purchases.min(u16::MAX as u64),
        "statementOutstandingCents": cents(outstanding),
        "ledgerHead": p["ledgerHead"],
        "ledgerSeq": p["ledgerSeq"],
        "postingsSinceSnapshot": postings_applied,
    }))
}

fn posting_references(card: &StoredCardRecord) -> Vec<String> {
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let last = card.record["billing"]["nextSeq"].as_u64().unwrap_or(1);
    let mut refs = vec![statements::open_reference(card_id)];
    for seq in 1..last {
        refs.push(format!("post:{card_id}:{seq:06}"));
    }
    refs
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReconcileRequest {
    pub client_operation_id: String,
}

/// `POST /v1/cards/{cardId}/recovery/reconcile` (owner), after the co-signed
/// `restore` landed (PER `recovery_state == 2`): replay every issuer event
/// ChainPay never applied, then hand the owner an unsigned
/// `confirm_reconciled` bound to the reviewed digest. The card stays frozen.
pub async fn reconcile_after_restore(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: ReconcileRequest,
) -> Result<Value, CardsError> {
    use base64::Engine;
    operation_id(&body.client_operation_id)?;
    let card = owned_card(cards, caller, card_id).await?;
    let (policy_pda, period_pda) = card_pdas(&card)?;
    let policy = match cards.per.read(&policy_pda, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => {
            program::decode_policy(&data).map_err(|_| CardsError::internal())?
        }
        TeeRead::NotVisible { .. } => {
            return Err(CardsError::conflict(
                "policy_not_visible",
                "The restored state is not visible to ChainPay's authorizer yet",
            ));
        }
        TeeRead::RpcError(_) => {
            return Err(CardsError::unavailable(
                "per_unavailable",
                "The private rollup is unreachable; retry",
            ));
        }
    };
    if policy.recovery_state != 2 {
        return Err(CardsError::conflict(
            "not_restored",
            "Sign the co-signed restore first",
        ));
    }
    let wanted = card.record["recovery"]["reconDigest"]
        .as_str()
        .and_then(program::unhex::<32>);
    if wanted != Some(policy.recon_digest) {
        return Err(CardsError::conflict(
            "recon_digest_mismatch",
            "The restore on PER does not match the reviewed report",
        ));
    }
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let since = latest_snapshot(cards, &card)
        .await
        .and_then(|(_, s)| s["takenAt"].as_str().map(str::to_owned));
    let truths = cards
        .lithic
        .list_transactions(&issuer.card_token, since.as_deref())
        .await
        .map_err(|_| {
            CardsError::unavailable("issuer_unavailable", "Issuer history is unavailable; retry")
        })?;
    if !truths.complete {
        return Err(CardsError::unavailable(
            "issuer_history_incomplete",
            "Issuer history is longer than one page; retry after reconciliation",
        ));
    }
    let mut replayed = 0u64;
    let applied = |row: Option<StoredCardRecord>| {
        row.map(|r| r.record["appliedEventIds"].as_array().map_or(0, Vec::len))
            .unwrap_or(0)
    };
    for truth in &truths.transactions {
        let Some(token) = truth["token"].as_str() else {
            continue;
        };
        let before = applied(cards.txn(token).await.ok().flatten());
        super::events::apply_transaction(cards, &card, truth)
            .await
            .map_err(|_| {
                CardsError::unavailable(
                    "replay_incomplete",
                    "Some issuer events could not be applied yet; retry",
                )
            })?;
        let after = applied(cards.txn(token).await.ok().flatten());
        replayed += after.saturating_sub(before) as u64;
    }
    let owner: solana_address::Address = card
        .index
        .owner
        .clone()
        .unwrap_or_default()
        .parse()
        .map_err(|_| CardsError::internal())?;
    let blockhash = cards.per.blockhash().await.ok_or_else(|| {
        CardsError::unavailable(
            "per_unavailable",
            "The private rollup is unreachable; retry",
        )
    })?;
    let tx = program::unsigned_transaction(
        &owner,
        &[program::confirm_reconciled(
            &owner,
            &policy_pda,
            &period_pda,
            &policy.recon_digest,
        )],
        blockhash,
    );
    let at = rfc3339(now_ms());
    let _ = cards
        .update_card(card_id, |record| {
            record["recovery"]["state"] = json!("reconciled_pending_owner_confirm");
            record["recovery"]["issuerEventsReplayed"] = json!(replayed);
            record["recovery"]["reconciledAt"] = json!(at);
        })
        .await;
    Ok(json!({
        "state": "reconciled_pending_owner_confirm",
        "issuerEventsReplayed": replayed,
        "reconDigest": program::hex(&policy.recon_digest),
        "confirmReconciledTx": base64::engine::general_purpose::STANDARD.encode(program::serialize_transaction(&tx)),
        "next": "Sign confirm_reconciled over your own PER session. The card stays frozen until you unfreeze it.",
    }))
}

#[cfg(test)]
mod unit {
    use super::*;

    fn policy(seq: u64, head: [u8; 32], recovery: u8) -> program::CardPolicyAccount {
        let data = super::super::fake_per::encode_policy(&super::super::fake_per::FakePolicy {
            ledger_seq: seq,
            recovery,
            ..Default::default()
        });
        let mut p = program::decode_policy(&data).unwrap();
        p.ledger_head = head;
        p
    }

    #[test]
    fn loss_is_classified_from_per_and_the_last_snapshot() {
        assert_eq!(classify(None, Some(3), None), Some(Loss::NotVisible));
        assert_eq!(
            classify(Some(&policy(2, [1; 32], 0)), Some(3), Some([1; 32])),
            Some(Loss::LedgerRegressed)
        );
        assert_eq!(
            classify(Some(&policy(3, [2; 32], 0)), Some(3), Some([1; 32])),
            Some(Loss::LedgerDiverged)
        );
        assert_eq!(
            classify(Some(&policy(3, [1; 32], 0)), Some(3), Some([1; 32])),
            None
        );
        assert_eq!(
            classify(Some(&policy(9, [5; 32], 0)), Some(3), Some([1; 32])),
            None
        );
        assert_eq!(
            classify(Some(&policy(9, [5; 32], 1)), Some(3), None),
            Some(Loss::OnChain)
        );
        assert_eq!(classify(Some(&policy(0, [0; 32], 0)), None, None), None);
    }
}
