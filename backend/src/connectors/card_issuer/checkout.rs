//! Checkout capabilities (contracts.md §6) and the sandbox checkout runner.
//!
//! `cpcap_v1_<base64url(32 random bytes)>` is opaque and carries no card
//! data. Server state lives in `card_events intent:<intentId>`, found by
//! `sha256(capability)`. Redeeming is single-use (compare-and-swap) and runs a
//! Lithic `simulate/authorize` at the bound merchant; the PAN exists only in
//! memory for that one call. The ASA path then decides through PER.

use super::routes::{Caller, CardsError};
use super::tee::TxOutcome;
use super::{
    CONNECTOR, CardsConnector, Merchant, cents, log_id, merchant_by_ref, now_ms, parse_cents,
    program, rfc3339, updated_now,
};
use crate::storage::{CardIndex, CardKind, CardPut, StoredCardRecord};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const CAPABILITY_PREFIX: &str = "cpcap_v1_";
pub const INTENT_TTL_SECS: u64 = 540;

pub fn new_capability() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("randomness");
    format!("{CAPABILITY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn is_capability(value: &str) -> bool {
    value.len() == CAPABILITY_PREFIX.len() + 43
        && value.starts_with(CAPABILITY_PREFIX)
        && value[CAPABILITY_PREFIX.len()..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn capability_hash(capability: &str) -> String {
    program::hex(&Sha256::digest(
        format!("chainpay-card-capability:v1\n{capability}").as_bytes(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckoutIntentRequest {
    pub client_operation_id: String,
    pub merchant_ref: String,
    pub amount_cents: String,
    pub currency: String,
    #[serde(default)]
    pub description: Option<String>,
}

fn response(capability: &str, record: &Value, merchant: &Merchant) -> Value {
    json!({
        "capability": capability,
        "expiresAt": record["expiresAt"],
        "merchant": {"displayName": merchant.display_name},
        "amountCents": record["maxAmountCents"],
        "currency": "USD",
        "intentId": record["intentId"],
        "status": "ready",
    })
}

/// `POST /v1/cards/{cardId}/checkout-intents` for an agent connection scoped
/// to the card. Opens the intent on PER; never reserves.
pub async fn issue(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card: &StoredCardRecord,
    body: CheckoutIntentRequest,
) -> Result<Value, CardsError> {
    if !cards.config.checkout_enabled {
        return Err(CardsError::unavailable(
            "checkout_disabled",
            "Card checkout is not enabled on this deployment",
        ));
    }
    super::routes::operation_id(&body.client_operation_id)?;
    let merchant = merchant_by_ref(&body.merchant_ref).ok_or_else(|| {
        CardsError::bad(
            "unknown_merchant",
            "merchantRef is not a registered merchant",
        )
    })?;
    if body.currency != "USD" {
        return Err(CardsError::bad("currency", "Cards only spend USD"));
    }
    let amount = parse_cents(&body.amount_cents)
        .filter(|a| *a > 0)
        .ok_or_else(|| {
            CardsError::bad(
                "amount",
                "amountCents must be a positive integer-cent string",
            )
        })?;
    if body
        .description
        .as_ref()
        .is_some_and(|d| d.chars().count() > 80)
    {
        return Err(CardsError::bad(
            "description",
            "description must be at most 80 characters",
        ));
    }
    let agent = caller.agent_id().ok_or_else(|| {
        CardsError::forbidden("Card checkout needs an agent connection scoped to this card")
    })?;
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let owner = card.index.owner.clone().unwrap_or_default();
    let mut intent_id = [0u8; 16];
    getrandom::fill(&mut intent_id).expect("randomness");
    let claim_id = format!(
        "card-intent:v1:{card_id}:{}:{}",
        program::hex(&agent),
        body.client_operation_id
    );
    // Keyed digest only: the claim row is plaintext in Convex.
    let request_digest = json!({"v": 2, "terms": cards.crypto.blind("checkout-terms", json!({"merchantRef": body.merchant_ref, "amountCents": cents(amount)}).to_string().as_bytes())});
    let (won, _, stored_intent, initial) = cards
        .store
        .claim_operation(
            &claim_id,
            &owner,
            request_digest.clone(),
            json!({"intentId": program::hex(&intent_id)}),
        )
        .await?;
    if !won {
        if stored_intent != request_digest {
            return Err(CardsError::conflict(
                "operation_reused",
                "clientOperationId was already used for a different checkout",
            ));
        }
        let id = initial["intentId"].as_str().unwrap_or_default();
        return resume(cards, card, id, merchant).await;
    }
    let capability = new_capability();
    let hash = capability_hash(&capability);
    let key = format!("intent:{}", program::hex(&intent_id));
    let expires_secs = now_ms() / 1000 + INTENT_TTL_SECS;
    let merchant_hash = program::merchant_id_hash(merchant.acceptor_id);
    let record = json!({
        "v": 1,
        "type": "intent",
        "cardId": card_id,
        "intentId": program::hex(&intent_id),
        "agent": bs58::encode(agent).into_string(),
        "maxAmountCents": cents(amount),
        "currency": "USD",
        "expiresAtSecs": expires_secs,
        "expiresAt": rfc3339(expires_secs * 1000),
        "state": "opening",
        "capabilityHash": hash,
        "createdAt": rfc3339(now_ms()),
        // The capability itself, sealed, so a retried request with the same
        // clientOperationId gets the same single-use capability back.
        // The merchant stays sealed too: an intent row must not reveal which
        // shops the card may use.
        "secret": cards.crypto.seal_json(CardKind::CardEvents.as_str(), &key, &json!({"capability": capability, "merchantRef": merchant.reference})),
    });
    let index = CardIndex {
        owner: Some(owner.clone()),
        connector: Some(CONNECTOR.into()),
        reference: Some(super::asa::match_reference(cards, &card_id, &merchant_hash)),
        idempotency: Some(format!("cap:{hash}")),
    };
    let row = match cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &key,
            index,
            record,
            None,
            updated_now(),
        )
        .await?
    {
        CardPut::Written(row) => row,
        CardPut::Conflict(_) => {
            return Err(CardsError::conflict(
                "intent_exists",
                "Intent id collision; retry",
            ));
        }
    };
    open_on_per(cards, card, row, merchant, &capability).await
}

async fn open_on_per(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    row: StoredCardRecord,
    merchant: &Merchant,
    capability: &str,
) -> Result<Value, CardsError> {
    let (policy, period) = super::routes::card_pdas(card)?;
    let intent_id = row.record["intentId"]
        .as_str()
        .and_then(program::unhex::<16>)
        .ok_or_else(CardsError::internal)?;
    let agent: [u8; 32] = row.record["agent"]
        .as_str()
        .and_then(|a| bs58::decode(a).into_vec().ok())
        .and_then(|v| v.try_into().ok())
        .ok_or_else(CardsError::internal)?;
    let instruction = program::open_checkout_intent(
        &cards.authorizer(),
        &policy,
        &period,
        &program::IntentArgs {
            intent_id,
            agent,
            merchant_id_hash: program::merchant_id_hash(merchant.acceptor_id),
            mcc: 0,
            max_amount_cents: parse_cents(row.record["maxAmountCents"].as_str().unwrap_or(""))
                .ok_or_else(CardsError::internal)?,
            expires_at: row.record["expiresAtSecs"].as_i64().unwrap_or(0),
        },
    );
    let outcome = cards
        .per
        .submit(vec![instruction], Instant::now() + Duration::from_secs(8))
        .await;
    let (state, error) = match &outcome {
        TxOutcome::Confirmed { .. } => ("open", None),
        TxOutcome::ProgramError { code, .. } => ("failed", Some(*code)),
        TxOutcome::Failed { .. } => ("failed", None),
        TxOutcome::Unknown { .. } => ("unknown", None),
    };
    let signature = outcome.signature().map(str::to_owned);
    let key = row.key.clone();
    let mut record = row.record.clone();
    record["state"] = json!(state);
    record["perTx"] = json!(signature);
    if let Some(code) = error {
        record["programError"] = json!(program::error_name(code));
    }
    cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &key,
            row.index.clone(),
            record.clone(),
            Some(row.rev()),
            updated_now(),
        )
        .await?;
    super::card_log!("intent {} -> {state}", log_id(&key));
    match (state, error) {
        ("open", _) => Ok(response(capability, &record, merchant)),
        ("failed", Some(code)) => Err(CardsError::conflict(
            "intent_refused",
            match program::decline_reason_for(code) {
                "merchant_not_allowed" => "This card doesn't allow that shop",
                "over_budget" => "That amount is more than this card has left this period",
                "over_max" => "That amount is over this card's per-purchase limit",
                "frozen" => "This card is frozen",
                _ => "The card's private policy refused this checkout",
            },
        )
        .with_detail(program::error_name(code).unwrap_or("unknown"))),
        ("unknown", _) => Err(CardsError::unknown(
            "The private rollup did not confirm in time; retry with the same clientOperationId",
        )),
        _ => Err(CardsError::unavailable(
            "per_unavailable",
            "The private rollup refused the request; retry later",
        )),
    }
}

/// Same clientOperationId again: hand back the same capability, or finish an
/// interrupted open by checking PER for the intent account.
async fn resume(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    intent_id: &str,
    merchant: &Merchant,
) -> Result<Value, CardsError> {
    let key = format!("intent:{intent_id}");
    let row = cards
        .store
        .get_card_record(CardKind::CardEvents, &key)
        .await?
        .ok_or_else(|| {
            CardsError::unknown(
                "The first attempt did not finish; retry with a new clientOperationId",
            )
        })?;
    let capability: String = cards
        .crypto
        .open_json::<Value>(CardKind::CardEvents.as_str(), &key, &row.record["secret"])
        .ok()
        .and_then(|v| v["capability"].as_str().map(str::to_owned))
        .ok_or_else(CardsError::internal)?;
    match row.record["state"].as_str() {
        Some("open") => Ok(response(&capability, &row.record, merchant)),
        Some("opening" | "unknown") => {
            let (policy, _) = super::routes::card_pdas(card)?;
            let pda = program::intent_pda(
                &policy,
                &program::unhex::<16>(intent_id).ok_or_else(CardsError::internal)?,
            );
            match cards.per.read(&pda, Duration::from_secs(4)).await {
                super::tee::TeeRead::Visible { .. } => {
                    let mut record = row.record.clone();
                    record["state"] = json!("open");
                    cards
                        .store
                        .put_card_record(
                            CardKind::CardEvents,
                            &key,
                            row.index.clone(),
                            record.clone(),
                            Some(row.rev()),
                            updated_now(),
                        )
                        .await?;
                    Ok(response(&capability, &record, merchant))
                }
                super::tee::TeeRead::NotVisible { .. } if row.record["state"] == "opening" => {
                    open_on_per(cards, card, row, merchant, &capability).await
                }
                _ => Err(CardsError::unknown(
                    "Still waiting for the private rollup; retry shortly",
                )),
            }
        }
        Some("redeemed" | "consumed" | "closed") => Err(CardsError::conflict(
            "capability_used",
            "This checkout was already used",
        )),
        _ => Err(CardsError::conflict(
            "intent_refused",
            "This checkout was refused; start a new one",
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedeemRequest {
    pub capability: String,
    /// Where the runner is actually checking out (defaults to the bound
    /// merchant). A different merchant or amount is refused by PER and the
    /// capability is consumed either way.
    #[serde(default)]
    pub merchant_ref: Option<String>,
    #[serde(default)]
    pub amount_cents: Option<String>,
}

/// `POST /v1/cards/checkout/redeem` (internal runner only).
pub async fn redeem(cards: &Arc<CardsConnector>, body: RedeemRequest) -> Result<Value, CardsError> {
    if !cards.config.checkout_enabled {
        return Err(CardsError::unavailable(
            "checkout_disabled",
            "Card checkout is not enabled on this deployment",
        ));
    }
    if !is_capability(&body.capability) {
        return Err(CardsError::bad("capability", "Not a checkout capability"));
    }
    let hash = capability_hash(&body.capability);
    let row = cards
        .store
        .find_card_record_by_idempotency(CardKind::CardEvents, &format!("cap:{hash}"))
        .await?
        .ok_or_else(|| CardsError::not_found("Unknown checkout capability"))?;
    if row.record["state"] != "open" {
        return Err(CardsError::conflict(
            "capability_used",
            "This checkout capability was already used or never opened",
        ));
    }
    if row.record["expiresAtSecs"].as_u64().unwrap_or(0) <= now_ms() / 1000 {
        return Err(CardsError::conflict(
            "capability_expired",
            "This checkout capability expired",
        ));
    }
    let sealed: Value = cards
        .crypto
        .open_json(
            CardKind::CardEvents.as_str(),
            &row.key,
            &row.record["secret"],
        )
        .map_err(|_| CardsError::internal())?;
    let bound = merchant_by_ref(sealed["merchantRef"].as_str().unwrap_or(""))
        .ok_or_else(CardsError::internal)?;
    let merchant = match &body.merchant_ref {
        Some(reference) => merchant_by_ref(reference).ok_or_else(|| {
            CardsError::bad(
                "unknown_merchant",
                "merchantRef is not a registered merchant",
            )
        })?,
        None => bound,
    };
    let amount = match &body.amount_cents {
        Some(value) => parse_cents(value).filter(|a| *a > 0).ok_or_else(|| {
            CardsError::bad(
                "amount",
                "amountCents must be a positive integer-cent string",
            )
        })?,
        None => parse_cents(row.record["maxAmountCents"].as_str().unwrap_or(""))
            .ok_or_else(CardsError::internal)?,
    };
    // Single use: consume before anything reaches the issuer.
    // 16 bytes: 32 hex characters, an identifier for the Convex card-data guard.
    let mut run_id = [0u8; 16];
    getrandom::fill(&mut run_id).expect("randomness");
    let run_id = program::hex(&run_id);
    let mut record = row.record.clone();
    record["state"] = json!("redeemed");
    record["runId"] = json!(run_id);
    record["redeemedAt"] = json!(rfc3339(now_ms()));
    match cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &row.key,
            row.index.clone(),
            record,
            Some(row.rev()),
            updated_now(),
        )
        .await?
    {
        CardPut::Written(_) => {}
        CardPut::Conflict(_) => {
            return Err(CardsError::conflict(
                "capability_used",
                "This checkout capability was already used",
            ));
        }
    }
    let card_id = row.record["cardId"].as_str().unwrap_or_default();
    let card = cards
        .card(card_id)
        .await?
        .ok_or_else(CardsError::internal)?;
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let result = cards
        .lithic
        .with_pan(&issuer.card_token, |pan| async move {
            cards
                .lithic
                .simulate_authorize(
                    &pan,
                    amount,
                    merchant.descriptor,
                    &merchant.mcc.to_string(),
                    merchant.acceptor_id,
                )
                .await
        })
        .await;
    let (state, token) = match result {
        Ok(token) => ("submitted", Some(token)),
        Err(_) => ("issuer_error", None),
    };
    let _ = cards
        .update_txn_or_intent(&row.key, |record| {
            record["runState"] = json!(state);
            if let Some(token) = &token {
                record["txn"] = json!(token);
            }
        })
        .await;
    super::card_log!("checkout run {} -> {state}", log_id(&run_id));
    match token {
        Some(token) => Ok(json!({"runId": run_id, "state": state, "lithicToken": token})),
        None => Err(CardsError::unavailable(
            "issuer_unavailable",
            "The issuer sandbox refused the simulated checkout; the capability is consumed",
        )),
    }
}

impl CardsConnector {
    /// CAS helper for any card_events row.
    pub async fn update_txn_or_intent<F>(
        &self,
        key: &str,
        mut f: F,
    ) -> Result<(), crate::storage::StorageError>
    where
        F: FnMut(&mut Value),
    {
        for _ in 0..4 {
            let Some(row) = self
                .store
                .get_card_record(CardKind::CardEvents, key)
                .await?
            else {
                return Ok(());
            };
            let mut record = row.record.clone();
            f(&mut record);
            if matches!(
                self.store
                    .put_card_record(
                        CardKind::CardEvents,
                        key,
                        row.index.clone(),
                        record,
                        Some(row.rev()),
                        updated_now()
                    )
                    .await?,
                CardPut::Written(_)
            ) {
                return Ok(());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn capabilities_are_opaque_and_well_formed() {
        let cap = new_capability();
        assert!(is_capability(&cap));
        assert!(!is_capability("cpcap_v1_short"));
        assert!(!is_capability(&cap.replace("cpcap_v1_", "cpcap_v2_")));
        assert_ne!(capability_hash(&cap), capability_hash(&new_capability()));
    }
}
