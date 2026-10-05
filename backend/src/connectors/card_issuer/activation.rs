//! Card activation as one durable, resumable operation (audit R2, A4/A7).
//!
//! Order, each step persisted on the card row under `activation.steps`:
//!
//! 1. **mirror**: copy the hard limits to the issuer's card controls while the
//!    card is still `PAUSED` (an open card keeps its old controls until the
//!    new ones exist);
//! 2. **rules**: retire the issuer rules the new mirror replaced (a failure
//!    leaves the stricter old rules in place and is retried by reconcile);
//! 3. **checkpoint**: schedule a `CardCommitment` write on PER;
//! 4. **commitment**: read the commitment back from the base layer and check
//!    its seq, policy version and period against what was scheduled. A
//!    checkpoint PER accepted is only *scheduled*: it is not a public proof;
//! 5. **issuer**: re-check the policy version is still current, then open the
//!    issuer card and record the issuer's own answer.
//!
//! A retry with any `clientOperationId` for the same policy version, and the
//! reconcile cron, resume this same operation. Nothing here creates a second
//! activation to get past an uncertain step, and nothing reports the card
//! active, paused or opened unless the issuer or the chain said so.

use super::program::{self, CommitmentAccount};
use super::routes::{self, Caller, CardsError, VersionedRequest};
use super::{CardIssuerSecret, CardsConnector, log_id, merchant_by_hash, now_ms, rfc3339};
use crate::storage::StoredCardRecord;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// `activation.state` values (also in the card view).
pub mod state {
    /// Limits are being copied to the issuer.
    pub const MIRRORING: &str = "mirroring";
    /// The issuer refused the limits; see the card's actual issuer state.
    pub const MIRROR_FAILED: &str = "mirror_failed";
    /// Limits mirrored; the public commitment is not read back from Solana yet.
    pub const PENDING_COMMITMENT: &str = "pending_commitment";
    /// Limits mirrored and the commitment confirmed, but the issuer has not
    /// confirmed the card open (issuer error, or new activations are off).
    pub const ISSUER_PENDING: &str = "issuer_pending";
    /// Everything is in place but the card is frozen or in recovery on PER,
    /// so the issuer card stays as it is.
    pub const HELD: &str = "held";
    /// Issuer open, limits mirrored for this policy version, public
    /// commitment confirmed on the base layer.
    pub const ACTIVE: &str = "active";
    /// The owner changed the policy since; activate the new version.
    pub const SUPERSEDED: &str = "superseded";
}

/// How long one request waits for the base-layer commitment before it answers
/// `pending_commitment`. Retries and the reconcile cron finish the rest.
#[cfg(not(test))]
const REQUEST_READBACK: Duration = Duration::from_secs(6);
#[cfg(test)]
const REQUEST_READBACK: Duration = Duration::from_millis(300);
#[cfg(not(test))]
const READBACK_INTERVAL: Duration = Duration::from_millis(1_500);
#[cfg(test)]
const READBACK_INTERVAL: Duration = Duration::from_millis(100);
/// A checkpoint PER accepted whose base write has not appeared after this
/// long is `stalled`: the scheduled action is presumed lost and the repair
/// phase schedules the next seq for the same card state.
pub const COMMITMENT_STALL_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The owner's activate request: waits briefly for the readback and
    /// reports failures as errors.
    Request,
    /// The reconcile cron: one readback per pass; partial states are not errors.
    Reconcile,
}

/// Refusal while `CARDS_NEW_ACTIVATION_ENABLED=false`.
pub fn gate_error() -> CardsError {
    CardsError::disabled(
        "new_activation_disabled",
        "New card activation is paused on this deployment. Existing cards, freezes, statements and recovery keep working.",
    )
}

// ------------------------------------------------------------- readback

/// Base-layer readback of a card's `CardCommitment`.
#[derive(Debug, Clone)]
pub enum Readback {
    Account(CommitmentAccount),
    /// The account does not exist or holds no commitment yet.
    Missing,
    /// RPC failure, no base chain attached, or undecodable bytes: nothing learned.
    Unavailable,
}

pub async fn read_commitment(cards: &CardsConnector, card: &StoredCardRecord) -> Readback {
    let (Some(base), Some(address)) = (cards.base(), card.record["commitmentPda"].as_str()) else {
        return Readback::Unavailable;
    };
    match base.account(address).await {
        Ok(Some(account)) => match program::decode_commitment(&account.data) {
            Ok(decoded) if decoded.seq > 0 => Readback::Account(decoded),
            Ok(_) => Readback::Missing,
            Err(_) => Readback::Unavailable,
        },
        Ok(None) => Readback::Missing,
        Err(()) => Readback::Unavailable,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Match {
    /// The base layer holds this checkpoint (or a later one for the same
    /// policy version).
    Confirmed,
    /// Not written yet.
    Pending,
    /// The base layer holds this seq with another policy version or period,
    /// or a later seq for another policy version.
    Mismatch,
}

/// Compare a base-layer commitment with the checkpoint ChainPay scheduled.
pub fn compare(
    expected_seq: u64,
    expected_version: Option<u64>,
    expected_period: Option<u64>,
    actual: &CommitmentAccount,
) -> Match {
    let version_ok = expected_version.is_none_or(|v| v == actual.policy_version as u64);
    if actual.seq < expected_seq {
        Match::Pending
    } else if actual.seq == expected_seq {
        let period_ok = expected_period.is_none_or(|p| p == actual.period_index as u64);
        if version_ok && period_ok {
            Match::Confirmed
        } else {
            Match::Mismatch
        }
    } else if version_ok {
        Match::Confirmed
    } else {
        Match::Mismatch
    }
}

fn seq_of(commitment: &Value) -> Option<u64> {
    commitment["seq"].as_str().and_then(|s| s.parse().ok())
}

/// Live commitment view for the card route: what the base layer holds,
/// judged against the checkpoint ChainPay last scheduled.
pub fn commitment_readback_view(card: &StoredCardRecord, actual: &CommitmentAccount) -> Value {
    let expected = &card.record["commitment"];
    let version = expected["policyVersion"]
        .as_u64()
        .or(card.record["mirror"]["policyVersion"].as_u64());
    let state = match seq_of(expected) {
        Some(seq) => match compare(seq, version, expected["periodIndex"].as_u64(), actual) {
            Match::Confirmed => "confirmed",
            Match::Pending => "pending",
            Match::Mismatch => "mismatch",
        },
        // ChainPay has no record of scheduling it: show it, prove nothing.
        None => "unverified",
    };
    let mut view = json!({
        "seq": actual.seq.to_string(),
        "root": program::hex(&actual.root),
        "slot": actual.written_slot.to_string(),
        "policyVersion": actual.policy_version,
        "periodIndex": actual.period_index,
        "state": state,
        "source": "base_readback",
    });
    if let Some(seq) = seq_of(expected) {
        view["expectedSeq"] = json!(seq.to_string());
    }
    if let Some(checkpoint) = expected["state"].as_str() {
        view["checkpoint"] = json!(checkpoint);
    }
    view
}

/// Commitment view from the stored record (list route, activate response).
/// `state` is `confirmed` only when a base-layer readback matched.
pub fn commitment_record_view(record: &Value) -> Option<Value> {
    let c = &record["commitment"];
    let seq = seq_of(c)?;
    let checkpoint = c["state"].as_str().unwrap_or("pending");
    let state = match checkpoint {
        "confirmed" => "confirmed",
        "mismatch" => "mismatch",
        _ => "pending",
    };
    let mut view = json!({"seq": seq.to_string(), "state": state, "checkpoint": checkpoint, "source": "recorded"});
    for field in [
        "policyVersion",
        "periodIndex",
        "slot",
        "root",
        "confirmedAt",
    ] {
        if !c[field].is_null() {
            view[field] = c[field].clone();
        }
    }
    Some(view)
}

// ------------------------------------------------------------- checkpoint

async fn load(cards: &CardsConnector, card_id: &str) -> Result<StoredCardRecord, CardsError> {
    cards.card(card_id).await?.ok_or_else(CardsError::internal)
}

async fn per_commit_seq(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Result<u64, CardsError> {
    Ok(routes::read_policy(cards, card).await?.commit_seq)
}

/// One repair step for the card's latest checkpoint, always the same
/// persisted one: read it back from the base layer; if PER never took it,
/// submit the same seq again (same sealed salt); if PER took it but the base
/// write is overdue, mark it `stalled` and schedule the next seq for the same
/// card state. Returns the stored commitment record (or `null` if the card
/// never had a checkpoint and none is due).
pub async fn repair_commitment(cards: &CardsConnector, card_id: &str) -> Result<Value, CardsError> {
    let card = load(cards, card_id).await?;
    let c = card.record["commitment"].clone();
    let due = !card.record["checkpointDue"].is_null();
    let Some(seq) = seq_of(&c) else {
        if due {
            return routes::checkpoint(cards, &card).await;
        }
        return Ok(Value::Null);
    };
    if c["state"] == "confirmed" {
        if due {
            return routes::checkpoint(cards, &card).await;
        }
        return Ok(c);
    }
    match read_commitment(cards, &card).await {
        Readback::Unavailable => return Ok(c),
        Readback::Account(actual) => {
            match compare(
                seq,
                c["policyVersion"].as_u64(),
                c["periodIndex"].as_u64(),
                &actual,
            ) {
                Match::Confirmed => {
                    let at = rfc3339(now_ms());
                    let mut confirmed = c.clone();
                    confirmed["state"] = json!("confirmed");
                    confirmed["confirmedAt"] = json!(at);
                    confirmed["slot"] = json!(actual.written_slot.to_string());
                    confirmed["root"] = json!(program::hex(&actual.root));
                    confirmed["observedSeq"] = json!(actual.seq.to_string());
                    cards
                        .update_card(card_id, |record| {
                            record["commitment"] = confirmed.clone();
                            record["commitmentConfirmed"] = confirmed.clone();
                        })
                        .await?
                        .ok_or_else(CardsError::internal)?;
                    cards.metrics.count("commitments_confirmed");
                    card_log!("commitment confirmed for card {}", log_id(card_id));
                    return Ok(confirmed);
                }
                Match::Mismatch => {
                    // The chain proves a different card state than the one
                    // scheduled (the policy changed in between). Record what
                    // was observed and prove the current state instead.
                    let observed = json!({"seq": actual.seq.to_string(), "policyVersion": actual.policy_version, "periodIndex": actual.period_index});
                    cards
                        .update_card(card_id, |record| {
                            record["commitment"]["state"] = json!("mismatch");
                            record["commitment"]["observed"] = observed.clone();
                        })
                        .await?
                        .ok_or_else(CardsError::internal)?;
                    card_log!("commitment mismatch for card {}", log_id(card_id));
                    let fresh = load(cards, card_id).await?;
                    return routes::checkpoint(cards, &fresh).await;
                }
                Match::Pending => {}
            }
        }
        Readback::Missing => {}
    }
    // Not on the base layer yet. Did PER take the checkpoint?
    let committed = per_commit_seq(cards, &card).await?;
    if committed < seq {
        // Never landed on PER (failed or dropped): the same seq again.
        return routes::checkpoint(cards, &card).await;
    }
    let requested = c["requestedAt"]
        .as_str()
        .and_then(super::statements::parse_rfc3339_ms)
        .unwrap_or(0);
    if now_ms().saturating_sub(requested) > COMMITMENT_STALL_MS {
        cards
            .update_card(card_id, |record| {
                record["commitment"]["state"] = json!("stalled");
            })
            .await?
            .ok_or_else(CardsError::internal)?;
        cards.metrics.count("commitments_stalled");
        card_log!(
            "commitment stalled for card {}; scheduling the next seq",
            log_id(card_id)
        );
        let fresh = load(cards, card_id).await?;
        return routes::checkpoint(cards, &fresh).await;
    }
    if c["state"] != "scheduled" {
        // An Unknown or refused submit that PER actually took.
        let at = rfc3339(now_ms());
        let updated = cards
            .update_card(card_id, |record| {
                record["commitment"]["state"] = json!("scheduled");
                record["commitment"]["scheduledAt"] = json!(at);
            })
            .await?
            .ok_or_else(CardsError::internal)?;
        return Ok(updated.record["commitment"].clone());
    }
    Ok(c)
}

/// Make sure a checkpoint for `version` exists, then read it back (briefly
/// polling for a request, once for the cron).
async fn ensure_commitment(
    cards: &CardsConnector,
    card_id: &str,
    version: u32,
    trigger: Trigger,
) -> Result<Value, CardsError> {
    let card = load(cards, card_id).await?;
    let c = &card.record["commitment"];
    if seq_of(c).is_none() || c["policyVersion"].as_u64() != Some(version as u64) {
        routes::checkpoint(cards, &card).await?;
    }
    let deadline = Instant::now()
        + match trigger {
            Trigger::Request => REQUEST_READBACK,
            Trigger::Reconcile => Duration::ZERO,
        };
    loop {
        let commitment = repair_commitment(cards, card_id).await?;
        if commitment["state"] == "confirmed" || Instant::now() >= deadline {
            return Ok(commitment);
        }
        tokio::time::sleep(READBACK_INTERVAL).await;
    }
}

// ------------------------------------------------------------- mirror

pub struct Mirror {
    pub acks: Vec<Value>,
    pub rules: Vec<String>,
    pub all_merchants_mirrored: bool,
    /// Old rules the issuer did not retire (they stay active, stricter).
    pub retire_failed: Vec<String>,
}

pub struct MirrorFailure {
    pub reason: String,
    /// Rules created before the failure: retired later, never reused.
    pub created: Vec<String>,
}

/// Mirror the hard limits to Lithic card controls (defence in depth). Never
/// sends a zero spend limit. New rules first; old ones are retired only after
/// every replacement exists, so a failure never leaves a card without controls.
async fn mirror_limits(
    cards: &CardsConnector,
    issuer: &CardIssuerSecret,
    policy: &program::CardPolicyAccount,
    previous_rules: &[String],
) -> Result<Mirror, MirrorFailure> {
    let mut acks = Vec::new();
    let mut rules = Vec::new();
    let fail = |reason: String, created: &Vec<String>| MirrorFailure {
        reason,
        created: created.clone(),
    };
    cards
        .lithic
        .set_spend_limit(&issuer.card_token, policy.max_purchase_cents)
        .await
        .map_err(|e| fail(format!("spend limit: {e}"), &rules))?;
    acks.push(json!({"control": "spend_limit", "duration": "TRANSACTION"}));
    let merchants: Vec<Value> = policy
        .merchant_id_hashes
        .iter()
        .filter_map(merchant_by_hash)
        .map(|m| json!({"merchant_id": m.acceptor_id, "comment": m.reference}))
        .collect();
    let unmirrored = policy.merchant_id_hashes.len() - merchants.len();
    if !merchants.is_empty() {
        let token = cards
            .lithic
            .create_card_rule(
                &issuer.card_token,
                "chainpay merchant allowlist",
                "MERCHANT_LOCK",
                json!({"merchants": merchants}),
            )
            .await
            .map_err(|e| fail(format!("merchant lock: {e}"), &rules))?;
        acks.push(json!({"control": "merchant_lock"}));
        rules.push(token);
    }
    if !policy.mccs.is_empty() {
        let values: Vec<String> = policy.mccs.iter().map(|m| format!("{m:04}")).collect();
        let token = cards
            .lithic
            .create_card_rule(
                &issuer.card_token,
                "chainpay mcc allowlist",
                "CONDITIONAL_ACTION",
                json!({"action": {"type": "DECLINE", "code": "UNAUTHORIZED_MERCHANT"}, "conditions": [{"attribute": "MCC", "operation": "IS_NOT_ONE_OF", "value": values}]}),
            )
            .await
            .map_err(|e| fail(format!("mcc rule: {e}"), &rules))?;
        acks.push(json!({"control": "mcc_allowlist"}));
        rules.push(token);
    }
    let retiring: Vec<String> = previous_rules
        .iter()
        .filter(|r| !rules.contains(r))
        .cloned()
        .collect();
    let retire_failed = retire(cards, &retiring).await;
    Ok(Mirror {
        acks,
        rules,
        all_merchants_mirrored: unmirrored == 0,
        retire_failed,
    })
}

/// Deactivate issuer rules; returns the ones the issuer did not confirm.
async fn retire(cards: &CardsConnector, rules: &[String]) -> Vec<String> {
    let mut failed = Vec::new();
    for rule in rules {
        if cards
            .lithic
            .admin(
                reqwest::Method::PATCH,
                &format!("/v2/auth_rules/{rule}"),
                Some(json!({"state": "INACTIVE"})),
            )
            .await
            .is_err()
        {
            failed.push(rule.clone());
        }
    }
    failed
}

fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|r| {
            r.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Reconcile: retry retiring rules a mirror replaced. Returns how many are
/// still active at the issuer.
pub async fn retry_rule_retirement(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Result<usize, CardsError> {
    let pending = string_list(&card.record["mirror"]["rulesToRetire"]);
    if pending.is_empty() {
        return Ok(0);
    }
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let left = retire(cards, &pending).await;
    let count = left.len();
    cards
        .update_card(card_id, |record| {
            record["mirror"]["rulesToRetire"] = json!(left);
            if count == 0 && record["activation"]["steps"]["rules"] == "retire_pending" {
                record["activation"]["steps"]["rules"] = json!("retired");
            }
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    Ok(count)
}

// ------------------------------------------------------------- issuer

/// What the issuer says about the card, read back after a write.
async fn issuer_readback(cards: &CardsConnector, issuer: &CardIssuerSecret) -> Option<String> {
    cards
        .lithic
        .get_card(&issuer.card_token)
        .await
        .ok()
        .map(|c| c.state)
        .filter(|s| !s.is_empty())
}

/// After a failed mirror: the card must not be open on stale controls. Pause
/// it if the issuer shows it open, then read the state back. Returns the
/// issuer's own answer (`None` = unreadable), never an assumption.
async fn compensate(
    cards: &CardsConnector,
    card_id: &str,
    issuer: &CardIssuerSecret,
) -> Result<Option<String>, CardsError> {
    let before = issuer_readback(cards, issuer).await;
    if before.as_deref() != Some("PAUSED") {
        // Open, or unreadable: ask for PAUSED (idempotent) and read back.
        let _ = cards.lithic.set_state(&issuer.card_token, "PAUSED").await;
    }
    let after = if before.as_deref() == Some("PAUSED") {
        before
    } else {
        issuer_readback(cards, issuer).await
    };
    if let Some(state) = &after {
        let state = state.clone();
        cards
            .update_card(card_id, |record| {
                record["issuerState"] = json!(state);
                record["activation"]["steps"]["issuer"] = json!(state);
            })
            .await?
            .ok_or_else(CardsError::internal)?;
    } else {
        cards
            .update_card(card_id, |record| {
                record["activation"]["steps"]["issuer"] = json!("unknown");
            })
            .await?
            .ok_or_else(CardsError::internal)?;
    }
    Ok(after)
}

fn mirror_failed_error(reason: &str, issuer_state: Option<&str>) -> CardsError {
    let message = match issuer_state {
        Some("PAUSED") => {
            "Issuer controls could not be mirrored. The issuer confirms the card is paused. Retry with the same clientOperationId."
        }
        Some("OPEN") => {
            "Issuer controls could not be mirrored, and the issuer still shows the card open: pausing it did not take. Freeze the card, then retry."
        }
        _ => {
            "Issuer controls could not be mirrored, and ChainPay could not read the card's state back from the issuer. Freeze the card to be sure, then retry."
        }
    };
    CardsError::unavailable("mirror_failed", message).with_detail(reason)
}

// ------------------------------------------------------------- operation

async fn set_activation(
    cards: &CardsConnector,
    card_id: &str,
    state: &str,
    detail: Option<&str>,
) -> Result<StoredCardRecord, CardsError> {
    let at = rfc3339(now_ms());
    cards
        .update_card(card_id, |record| {
            record["activation"]["state"] = json!(state);
            record["activation"]["updatedAt"] = json!(at);
            record["activation"]["detail"] = detail.map_or(Value::Null, |d| json!(d));
            if state == self::state::ACTIVE {
                record["activation"]["completedAt"] = json!(at);
            }
        })
        .await?
        .ok_or_else(CardsError::internal)
}

fn with_card(error: CardsError, cards: &CardsConnector, card: &StoredCardRecord) -> CardsError {
    error.with_card(routes::card_view(cards, card, None, None))
}

/// `POST /v1/cards/{cardId}/activate`: after the owner signed
/// `init_permission` + `set_policy` on PER.
pub async fn activate(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: VersionedRequest,
) -> Result<Value, CardsError> {
    if !cards.config.new_activation_enabled {
        return Err(gate_error());
    }
    routes::operation_id(&body.client_operation_id)?;
    let card = routes::owned_card(cards, caller, card_id).await?;
    let version = body.expected_policy_version;
    let op = format!("card-activate:v1:{card_id}:{}", body.client_operation_id);
    let op_id = program::hex(&Sha256::digest(op.as_bytes())[..16]);
    let (won, _, stored, _) = cards
        .store
        .claim_operation(
            &op,
            &caller.wallet,
            json!({"cardId": card_id, "expectedPolicyVersion": version}),
            json!({"op": op_id}),
        )
        .await?;
    if !won && stored["expectedPolicyVersion"].as_u64() != Some(version as u64) {
        return Err(CardsError::conflict(
            "operation_reused",
            "clientOperationId was already used to activate a different policy version",
        ));
    }
    let policy = routes::read_policy(cards, &card).await?;
    if policy.authorizer != cards.authorizer() {
        return Err(CardsError::conflict(
            "authorizer_mismatch",
            "The card's policy names a different authorizer",
        ));
    }
    if policy.policy_version != version {
        return Err(CardsError::conflict(
            "policy_version",
            "The card's policy version changed; review it again",
        )
        .with_detail(&policy.policy_version.to_string()));
    }
    // One activation per policy version: a retry under another
    // clientOperationId resumes the persisted operation, never a second one.
    let current = &card.record["activation"];
    let resumes = current["policyVersion"].as_u64() == Some(version as u64)
        && current["state"] != state::SUPERSEDED;
    if !resumes {
        let at = rfc3339(now_ms());
        cards
            .update_card(card_id, |record| {
                record["activation"] = json!({
                    "opId": op_id,
                    "policyVersion": version,
                    "state": state::MIRRORING,
                    "startedAt": at,
                    "updatedAt": at,
                    "steps": {"mirror": "pending", "rules": "pending", "checkpoint": "pending", "commitment": "pending", "issuer": "pending"},
                });
            })
            .await?
            .ok_or_else(CardsError::internal)?;
    }
    let fresh = drive(cards, card_id, Trigger::Request).await?;
    Ok(routes::card_view(
        cards,
        &fresh,
        None,
        Some(&cards.attestation().await),
    ))
}

/// Advance the card's persisted activation as far as the issuer and the
/// chain allow. Request: failures are errors carrying the fresh card view.
/// Reconcile: partial states are left for the next pass.
pub async fn drive(
    cards: &Arc<CardsConnector>,
    card_id: &str,
    trigger: Trigger,
) -> Result<StoredCardRecord, CardsError> {
    let card = load(cards, card_id).await?;
    let act = card.record["activation"].clone();
    let Some(version) = act["policyVersion"].as_u64().map(|v| v as u32) else {
        return Ok(card);
    };
    if matches!(act["state"].as_str(), Some(state::SUPERSEDED)) {
        return Ok(card);
    }
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let policy = routes::read_policy(cards, &card).await?;
    if policy.policy_version != version {
        let card = set_activation(
            cards,
            card_id,
            state::SUPERSEDED,
            Some("policy_version_changed"),
        )
        .await?;
        return match trigger {
            Trigger::Reconcile => Ok(card),
            Trigger::Request => Err(with_card(
                CardsError::conflict(
                    "policy_version",
                    "The card's policy version changed; review it again",
                )
                .with_detail(&policy.policy_version.to_string()),
                cards,
                &card,
            )),
        };
    }

    // 1-2. Mirror (and retire replaced rules) while the issuer card is paused.
    let mirrored = act["steps"]["mirror"] == "acknowledged"
        && card.record["mirror"]["state"] == "acknowledged"
        && card.record["mirror"]["policyVersion"].as_u64() == Some(version as u64);
    if !mirrored {
        let previous = string_list(&card.record["mirror"]["rules"]);
        let mut to_retire = string_list(&card.record["mirror"]["rulesToRetire"]);
        let at = rfc3339(now_ms());
        match mirror_limits(cards, &issuer, &policy, &previous).await {
            Ok(m) => {
                for rule in m.retire_failed.iter() {
                    if !to_retire.contains(rule) {
                        to_retire.push(rule.clone());
                    }
                }
                to_retire.retain(|r| !m.rules.contains(r));
                let retire_pending = !to_retire.is_empty();
                // Control names only: list sizes are policy shape and stay out of storage.
                let mirror = json!({
                    "state": "acknowledged",
                    "ackAt": at,
                    "policyVersion": version,
                    "rules": m.rules,
                    "rulesToRetire": to_retire,
                    "allMerchantsMirrored": m.all_merchants_mirrored,
                    "detail": {"acks": m.acks, "allMerchantsMirrored": m.all_merchants_mirrored},
                });
                cards
                    .update_card(card_id, |record| {
                        record["mirror"] = mirror.clone();
                        record["activation"]["steps"]["mirror"] = json!("acknowledged");
                        record["activation"]["steps"]["rules"] = json!(if retire_pending {
                            "retire_pending"
                        } else {
                            "retired"
                        });
                        record["activation"]["state"] = json!(state::PENDING_COMMITMENT);
                        record["activation"]["updatedAt"] = json!(at);
                    })
                    .await?
                    .ok_or_else(CardsError::internal)?;
                routes::record_activity(
                    cards,
                    &card,
                    "policy_change",
                    json!({"policyVersion": version, "mirror": "acknowledged"}),
                )
                .await;
            }
            Err(failure) => {
                for rule in failure.created {
                    if !to_retire.contains(&rule) {
                        to_retire.push(rule);
                    }
                }
                let reason = failure.reason.clone();
                cards
                    .update_card(card_id, |record| {
                        record["mirror"]["state"] = json!("failed");
                        record["mirror"]["failedAt"] = json!(at);
                        record["mirror"]["policyVersion"] = json!(version);
                        record["mirror"]["rulesToRetire"] = json!(to_retire);
                        record["mirror"]["detail"] = json!({"error": reason});
                        record["activation"]["steps"]["mirror"] = json!("failed");
                        record["activation"]["state"] = json!(state::MIRROR_FAILED);
                        record["activation"]["updatedAt"] = json!(at);
                    })
                    .await?
                    .ok_or_else(CardsError::internal)?;
                routes::record_activity(
                    cards,
                    &card,
                    "policy_change",
                    json!({"policyVersion": version, "mirror": "failed"}),
                )
                .await;
                // Never leave a card open on a stale issuer mirror, and
                // report only what the issuer reads back.
                let issuer_state = compensate(cards, card_id, &issuer).await?;
                card_log!(
                    "mirror failed for card {}; issuer reads {}",
                    log_id(card_id),
                    issuer_state.as_deref().unwrap_or("unknown")
                );
                let card = load(cards, card_id).await?;
                return match trigger {
                    Trigger::Reconcile => Ok(card),
                    Trigger::Request => Err(with_card(
                        mirror_failed_error(&failure.reason, issuer_state.as_deref()),
                        cards,
                        &card,
                    )),
                };
            }
        }
    }

    // 3-4. Checkpoint, then the public commitment read back from Solana.
    let commitment = ensure_commitment(cards, card_id, version, trigger).await;
    let commitment = match commitment {
        Ok(c) => c,
        Err(error) => {
            let card = set_activation(
                cards,
                card_id,
                state::PENDING_COMMITMENT,
                Some("checkpoint_unavailable"),
            )
            .await?;
            return match trigger {
                Trigger::Reconcile => Ok(card),
                Trigger::Request => Err(with_card(error, cards, &card)),
            };
        }
    };
    let confirmed = commitment["state"] == "confirmed"
        && commitment["policyVersion"].as_u64() == Some(version as u64);
    let checkpoint_state = commitment["state"].as_str().unwrap_or("pending").to_owned();
    let seq = commitment["seq"].clone();
    cards
        .update_card(card_id, |record| {
            record["activation"]["steps"]["checkpoint"] =
                json!({"seq": seq, "state": checkpoint_state});
            record["activation"]["steps"]["commitment"] =
                json!(if confirmed { "confirmed" } else { "pending" });
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    if !confirmed {
        let card = set_activation(cards, card_id, state::PENDING_COMMITMENT, None).await?;
        return Ok(card);
    }

    // 5. The policy must still be the one that was mirrored and committed.
    let card = load(cards, card_id).await?;
    let policy = routes::read_policy(cards, &card).await?;
    if policy.policy_version != version {
        let card = set_activation(
            cards,
            card_id,
            state::SUPERSEDED,
            Some("policy_version_changed"),
        )
        .await?;
        return match trigger {
            Trigger::Reconcile => Ok(card),
            Trigger::Request => Err(with_card(
                CardsError::conflict(
                    "policy_version",
                    "The card's policy version changed; review it again",
                )
                .with_detail(&policy.policy_version.to_string()),
                cards,
                &card,
            )),
        };
    }
    if policy.frozen || policy.recovery_state != 0 {
        return set_activation(cards, card_id, state::HELD, Some("frozen_on_per")).await;
    }
    if card.record["issuerState"] != "OPEN" {
        if !cards.config.new_activation_enabled {
            // The gate went off after this activation was accepted: finish
            // the proof, but do not open a card that was never open.
            return set_activation(
                cards,
                card_id,
                state::ISSUER_PENDING,
                Some("new_activation_disabled"),
            )
            .await;
        }
        let opened = cards
            .lithic
            .set_state(&issuer.card_token, "OPEN")
            .await
            .ok()
            .map(|c| c.state)
            .filter(|s| !s.is_empty());
        // The PATCH answer is the issuer's acknowledgement; without one, read back.
        let issuer_state = match opened {
            Some(state) => Some(state),
            None => issuer_readback(cards, &issuer).await,
        };
        let at = rfc3339(now_ms());
        let state_now = issuer_state.clone();
        cards
            .update_card(card_id, |record| {
                if let Some(state) = &state_now {
                    record["issuerState"] = json!(state);
                }
                record["activation"]["steps"]["issuer"] =
                    json!(state_now.as_deref().unwrap_or("unknown"));
                record["activation"]["updatedAt"] = json!(at);
            })
            .await?
            .ok_or_else(CardsError::internal)?;
        if issuer_state.as_deref() != Some("OPEN") {
            let card = set_activation(
                cards,
                card_id,
                state::ISSUER_PENDING,
                Some("issuer_not_open"),
            )
            .await?;
            let message = match issuer_state.as_deref() {
                Some(state) => format!(
                    "Limits are mirrored and the public commitment is on Solana, but the issuer did not open the card (it reads {state}). Retry with the same clientOperationId."
                ),
                None => "Limits are mirrored and the public commitment is on Solana, but the issuer did not confirm opening the card and its state could not be read back. Retry with the same clientOperationId.".into(),
            };
            return match trigger {
                Trigger::Reconcile => Ok(card),
                Trigger::Request => Err(with_card(
                    CardsError::unavailable("issuer_unavailable", message),
                    cards,
                    &card,
                )),
            };
        }
    } else {
        cards
            .update_card(card_id, |record| {
                record["activation"]["steps"]["issuer"] = json!("OPEN");
            })
            .await?
            .ok_or_else(CardsError::internal)?;
    }
    let at = rfc3339(now_ms());
    cards
        .update_card(card_id, |record| {
            record["activatedAt"] = json!(at);
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    let card = set_activation(cards, card_id, state::ACTIVE, None).await?;
    cards.metrics.count("activations_completed");
    card_log!("activation complete for card {}", log_id(card_id));
    // A recovery snapshot of the activated state; a failure is flagged for
    // the reconcile pass, never dropped.
    snapshot_or_flag(cards, card_id).await;
    load(cards, card_id).await.or(Ok(card))
}

/// Whether the reconcile pass should drive this card's activation.
pub fn in_progress(card: &StoredCardRecord) -> bool {
    matches!(
        card.record["activation"]["state"].as_str(),
        Some(
            state::MIRRORING
                | state::MIRROR_FAILED
                | state::PENDING_COMMITMENT
                | state::ISSUER_PENDING
                | state::HELD
        )
    )
}

/// Take a recovery snapshot now; if it fails, flag `snapshotDue` so the
/// reconcile pass takes it.
pub async fn snapshot_or_flag(cards: &CardsConnector, card_id: &str) {
    let Ok(Some(card)) = cards.card(card_id).await else {
        return;
    };
    if let Err(reason) = super::reconcile::snapshot(cards, &card).await {
        card_log!("snapshot failed for card {}: {reason}", log_id(card_id));
        cards.metrics.count("snapshots_failed");
        let at = rfc3339(now_ms());
        if cards
            .update_card(card_id, |record| record["snapshotDue"] = json!(at))
            .await
            .is_err()
        {
            card_log!("snapshot flag not stored for card {}", log_id(card_id));
        }
    }
}

/// Schedule a checkpoint for the card's current state. On failure the card
/// is flagged `checkpointDue` (when nothing was persisted yet) so the
/// reconcile repair phase schedules it; the error is returned either way.
pub async fn checkpoint_or_flag(
    cards: &CardsConnector,
    card_id: &str,
    reason: &str,
) -> Result<Value, CardsError> {
    let card = load(cards, card_id).await?;
    match routes::checkpoint(cards, &card).await {
        Ok(commitment) => Ok(commitment),
        Err(error) => {
            card_log!(
                "checkpoint after {reason} failed for card {}: {}",
                log_id(card_id),
                error.code
            );
            cards.metrics.count("checkpoints_failed");
            let reason = reason.to_owned();
            if cards
                .update_card(card_id, |record| record["checkpointDue"] = json!(reason))
                .await
                .is_err()
            {
                card_log!("checkpoint flag not stored for card {}", log_id(card_id));
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    fn account(seq: u64, version: u32, period: u32) -> CommitmentAccount {
        CommitmentAccount {
            binding: solana_address::Address::default(),
            seq,
            root: [1; 32],
            policy_version: version,
            period_index: period,
            written_slot: 9,
        }
    }

    #[test]
    fn a_scheduled_checkpoint_is_confirmed_only_by_a_matching_readback() {
        assert_eq!(
            compare(3, Some(1), Some(1), &account(2, 1, 1)),
            Match::Pending
        );
        assert_eq!(
            compare(3, Some(1), Some(1), &account(3, 1, 1)),
            Match::Confirmed
        );
        assert_eq!(
            compare(3, Some(1), Some(1), &account(3, 2, 1)),
            Match::Mismatch
        );
        assert_eq!(
            compare(3, Some(1), Some(1), &account(3, 1, 2)),
            Match::Mismatch
        );
        // A later checkpoint for the same policy version also proves it.
        assert_eq!(
            compare(3, Some(1), Some(1), &account(4, 1, 2)),
            Match::Confirmed
        );
        assert_eq!(
            compare(3, Some(1), Some(1), &account(4, 2, 2)),
            Match::Mismatch
        );
    }

    #[test]
    fn recorded_views_never_call_a_scheduled_checkpoint_confirmed() {
        let view = commitment_record_view(
            &json!({"commitment": {"seq": "2", "state": "scheduled", "policyVersion": 1}}),
        )
        .unwrap();
        assert_eq!(view["state"], "pending");
        assert_eq!(view["checkpoint"], "scheduled");
        let view = commitment_record_view(
            &json!({"commitment": {"seq": "2", "state": "confirmed", "policyVersion": 1}}),
        )
        .unwrap();
        assert_eq!(view["state"], "confirmed");
        assert!(commitment_record_view(&json!({})).is_none());
    }

    #[test]
    fn the_gate_is_on_unless_explicitly_false_and_fails_closed_on_junk() {
        assert!(super::super::new_activation_enabled(None));
        assert!(super::super::new_activation_enabled(Some("true")));
        assert!(!super::super::new_activation_enabled(Some("false")));
        assert!(!super::super::new_activation_enabled(Some("off")));
    }
}
