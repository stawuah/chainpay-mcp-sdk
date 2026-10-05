//! Owner and agent card routes (contracts.md §3.4). Axum glue lives in
//! `server_cards.rs`; these functions take the authenticated caller and
//! return contract JSON or the contract error envelope
//! `{code, message, operationId?, retryable, evidenceState}`.
//!
//! No route returns a policy value (the browser reads those from PER with the
//! owner's own token), a PAN, CVV, TEE token or Lithic card token.

use super::program::{self, CardAccounts};
use super::tee::{TeeRead, TxOutcome};
use super::{
    CARD_LIST_REFERENCE, CONNECTOR, CardIssuerSecret, CardsConnector, card_key, cents, is_card_id,
    log_id, merchant_by_acceptor, now_ms, parse_cents, rfc3339, updated_now,
};
use crate::storage::{CardIndex, CardKind, CardPut, StorageError, StoredCardRecord};
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ------------------------------------------------------------------ caller

/// Authenticated identity, derived server-side from the owner session or MCP
/// connection. `connection` is the connection token hash (never the token).
#[derive(Debug, Clone)]
pub struct Caller {
    pub wallet: String,
    pub scope: Option<Value>,
    pub connection: Option<String>,
}

impl Caller {
    pub fn is_owner_session(&self) -> bool {
        self.scope.is_none()
    }

    /// Stable 32-byte agent identity bound into `CheckoutIntent.agent` for a
    /// scoped connection. Owner sessions have none (contracts.md §10).
    pub fn agent_id(&self) -> Option<[u8; 32]> {
        if self.scope.is_none() {
            return None;
        }
        let connection = self.connection.as_deref()?;
        Some(Sha256::digest(format!("chainpay-card-agent:v1\n{connection}").as_bytes()).into())
    }

    fn scope_allows(&self, card_id: &str, tool: &str) -> bool {
        let Some(scope) = &self.scope else {
            return false;
        };
        scope["cards"]
            .as_array()
            .is_some_and(|cards| cards.iter().any(|c| c.as_str() == Some(card_id)))
            && scope["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|t| t.as_str() == Some(tool)))
    }
}

// ------------------------------------------------------------------- errors

#[derive(Debug, Clone)]
pub struct CardsError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub evidence_state: &'static str,
    pub operation_id: Option<String>,
    pub detail: Option<String>,
    /// Fresh card view attached to a partial failure, so the client shows
    /// the state the issuer and chain actually reached.
    pub card: Option<Value>,
}

impl CardsError {
    fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
        evidence_state: &'static str,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable,
            evidence_state,
            operation_id: None,
            detail: None,
            card: None,
        }
    }
    pub fn bad(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message, false, "none")
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message, false, "none")
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message, false, "none")
    }
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message, false, "none")
    }
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "outcome_unknown",
            message,
            true,
            "unknown",
        )
    }
    pub fn unavailable(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message, true, "none")
    }
    /// A feature switched off on this deployment (not retryable).
    pub fn disabled(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            code,
            message,
            false,
            "none",
        )
    }
    pub fn with_card(mut self, card: Value) -> Self {
        self.card = Some(card);
        self
    }
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Card service error",
            true,
            "unknown",
        )
    }
    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::NOT_IMPLEMENTED,
            "not_implemented",
            message,
            false,
            "none",
        )
    }
    pub fn with_detail(mut self, detail: &str) -> Self {
        self.detail = Some(detail.to_owned());
        self
    }
    pub fn with_operation(mut self, id: &str) -> Self {
        self.operation_id = Some(id.to_owned());
        self
    }
}

impl From<StorageError> for CardsError {
    fn from(error: StorageError) -> Self {
        // Storage errors carry status codes only, never record contents.
        super::card_log!("storage error: {error}");
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_unavailable",
            "Card storage is unavailable; retry with the same clientOperationId",
            true,
            "unknown",
        )
    }
}

impl IntoResponse for CardsError {
    fn into_response(self) -> Response {
        super::card_log!("{} {}", self.status.as_u16(), self.code);
        let mut body = json!({"code": self.code, "message": self.message, "retryable": self.retryable, "evidenceState": self.evidence_state});
        if let Some(id) = &self.operation_id {
            body["operationId"] = json!(id);
        }
        if let Some(detail) = &self.detail {
            body["detail"] = json!(detail);
        }
        if let Some(card) = self.card {
            body["card"] = card;
        }
        (self.status, Json(body)).into_response()
    }
}

pub fn operation_id(value: &str) -> Result<(), CardsError> {
    if (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        Ok(())
    } else {
        Err(CardsError::bad(
            "client_operation_id",
            "clientOperationId must be 8-128 letters, digits or _.:-",
        ))
    }
}

pub fn card_pdas(card: &StoredCardRecord) -> Result<(Address, Address), CardsError> {
    let policy = card.record["policyPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(CardsError::internal)?;
    let period = card.record["periodPda"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(CardsError::internal)?;
    Ok((policy, period))
}

// ------------------------------------------------------------ authorization

/// The owner's own card, from an owner session (never a scoped connection).
pub async fn owned_card(
    cards: &CardsConnector,
    caller: &Caller,
    card_id: &str,
) -> Result<StoredCardRecord, CardsError> {
    if !caller.is_owner_session() {
        return Err(CardsError::forbidden("Owner session required"));
    }
    card_for(cards, &caller.wallet, card_id).await
}

async fn card_for(
    cards: &CardsConnector,
    wallet: &str,
    card_id: &str,
) -> Result<StoredCardRecord, CardsError> {
    if !is_card_id(card_id) {
        return Err(CardsError::not_found("Card not found"));
    }
    let card = cards
        .card(card_id)
        .await?
        .ok_or_else(|| CardsError::not_found("Card not found"))?;
    // Another owner's card is indistinguishable from a missing one.
    if card.index.owner.as_deref() != Some(wallet) {
        return Err(CardsError::not_found("Card not found"));
    }
    Ok(card)
}

/// Owner session, or a connection whose scope names this card and tool.
pub async fn readable_card(
    cards: &CardsConnector,
    caller: &Caller,
    card_id: &str,
    tool: &str,
) -> Result<StoredCardRecord, CardsError> {
    if !caller.is_owner_session() && !caller.scope_allows(card_id, tool) {
        return Err(CardsError::forbidden(
            "Connection does not permit this card or tool",
        ));
    }
    card_for(cards, &caller.wallet, card_id).await
}

/// Agent connection scoped to this card for checkout.
pub async fn agent_card(
    cards: &CardsConnector,
    caller: &Caller,
    card_id: &str,
) -> Result<StoredCardRecord, CardsError> {
    if caller.is_owner_session() {
        return Err(CardsError::forbidden(
            "Card checkout needs an agent connection scoped to this card",
        ));
    }
    if !caller.scope_allows(card_id, "request_card_checkout") {
        return Err(CardsError::forbidden(
            "Connection does not permit checkout on this card",
        ));
    }
    card_for(cards, &caller.wallet, card_id).await
}

// -------------------------------------------------------------------- views

fn attestation_label(status: &super::tee::AttestationStatus) -> &'static str {
    match (status.hardware, status.measurements) {
        ("verified", "match") => "Genuine TDX hardware and the expected MagicBlock build verified",
        ("verified", "mismatch") => "Genuine TDX hardware, but not the expected build",
        ("verified", _) => "Genuine TDX hardware verified, build measurements pending",
        ("failed", _) => "Attestation failed",
        _ => "Not verified yet",
    }
}

pub fn card_view(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    commitment: Option<Value>,
    attestation: Option<&super::tee::AttestationStatus>,
) -> Value {
    let issuer = cards.card_issuer(card);
    let r = &card.record;
    let mut mirror = json!({"state": r["mirror"]["state"].as_str().unwrap_or("pending")});
    if let Some(at) = r["mirror"]["ackAt"].as_str() {
        mirror["acknowledgedAt"] = json!(at);
    }
    if let Some(version) = r["mirror"]["policyVersion"].as_u64() {
        mirror["policyVersionMirrored"] = json!(version);
    }
    if let Some(all) = r["mirror"]["allMerchantsMirrored"].as_bool() {
        // false: some allowlisted shops are not in the issuer's merchant lock
        // (PER still enforces the full allowlist on every authorization).
        mirror["allMerchantsMirrored"] = json!(all);
    }
    if r["mirror"]["rulesToRetire"]
        .as_array()
        .is_some_and(|rules| !rules.is_empty())
    {
        mirror["rulesRetirePending"] = json!(true);
    }
    let mut view = json!({
        "cardId": r["cardId"],
        "label": cards.card_label(card),
        "lastFour": issuer.map(|i| i.last_four).unwrap_or_default(),
        "issuerState": r["issuerState"].as_str().unwrap_or("PAUSED"),
        "mirror": mirror,
        "freeze": {
            "onChain": r["freeze"]["onChain"].as_bool().unwrap_or(false),
            "issuer": r["freeze"]["issuer"].as_str().unwrap_or("confirmed"),
        },
        "accounts": {"binding": r["bindingPda"], "policy": r["policyPda"], "period": r["periodPda"], "commitment": r["commitmentPda"], "escrow": r["escrowPda"]},
        "simulatedCredit": true,
    });
    // A live base-layer readback when the caller has one, else the stored
    // record; `state: confirmed` only ever comes from a matching readback.
    if let Some(commitment) = commitment.or_else(|| super::activation::commitment_record_view(r)) {
        view["commitment"] = commitment;
    }
    if r["activation"].is_object() {
        let a = &r["activation"];
        let mut activation =
            json!({"state": a["state"], "policyVersion": a["policyVersion"], "steps": a["steps"]});
        for field in ["startedAt", "updatedAt", "completedAt", "detail"] {
            if !a[field].is_null() {
                activation[field] = a[field].clone();
            }
        }
        view["activation"] = activation;
    }
    if let Some(state) = r["recovery"]["state"].as_str() {
        let mut recovery = json!({"state": state});
        for field in [
            "reason",
            "detectedAt",
            "snapshotLedgerSeq",
            "issuerEventsReplayed",
            "reconDigest",
            "confirmedAt",
        ] {
            if !r["recovery"][field].is_null() {
                recovery[field] = r["recovery"][field].clone();
            }
        }
        // The reviewed numbers are spend state: sealed at rest, owner view only.
        if let Ok(report) = cards.crypto.open_json::<Value>(
            CardKind::Cards.as_str(),
            &card.key,
            &r["recoveryReport"],
        ) {
            recovery["report"] = report;
        }
        view["recovery"] = recovery;
    }
    if let Some(status) = attestation {
        view["attestation"] = json!({
            "mode": status.mode,
            "hardware": status.hardware,
            "measurements": status.measurements,
            "checkedAt": (status.checked_at_ms > 0).then(|| rfc3339(status.checked_at_ms)),
            "label": attestation_label(status),
        });
    }
    view["billing"] = json!({
        "label": super::statements::SIMULATED_LABEL,
        "lastStatementSeq": r["billing"]["lastStatementSeq"],
        "carriedCreditCents": r["billing"]["carriedCreditCents"].as_str().unwrap_or("0"),
    });
    view
}

// ------------------------------------------------------------------ prepare

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrepareRequest {
    pub client_operation_id: String,
    pub label: String,
}

fn accounts_json(accounts: &CardAccounts) -> Value {
    json!({
        "binding": accounts.binding.to_string(),
        "policy": accounts.policy.to_string(),
        "period": accounts.period.to_string(),
        "commitment": accounts.commitment.to_string(),
        "escrow": accounts.escrow.to_string(),
    })
}

fn prepared(
    cards: &CardsConnector,
    owner: &Address,
    card_id: &[u8; 32],
    card_ref_hash: &[u8; 32],
    blockhash: [u8; 32],
) -> Value {
    use base64::Engine;
    let accounts = CardAccounts::derive(owner, card_id);
    let encode = |ixs: Vec<solana_message::Instruction>| {
        base64::engine::general_purpose::STANDARD.encode(program::serialize_transaction(
            &program::unsigned_transaction(owner, &ixs, blockhash),
        ))
    };
    json!({
        "cardId": program::hex(card_id),
        "accounts": accounts_json(&accounts),
        "initTx": encode(vec![program::init_card(owner, card_id, cards.config.issuer_code, card_ref_hash, program::PREFUND_LAMPORTS)]),
        "delegateTx": encode(vec![program::delegate_card(owner, card_id)]),
        "escrowTopUpTx": encode(vec![program::top_up_escrow(owner, &accounts.policy, program::ESCROW_TOP_UP_LAMPORTS)]),
        "authorizer": cards.authorizer().to_string(),
        "teeValidator": program::TEE_VALIDATOR,
        "prefundLamports": program::PREFUND_LAMPORTS.to_string(),
    })
}

/// `POST /v1/cards/prepare`: create the Lithic card `PAUSED` + `VIRTUAL`,
/// store the encrypted registry row, and return unsigned base-layer
/// transactions for the owner's wallet.
pub async fn prepare(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    body: PrepareRequest,
    blockhash: [u8; 32],
) -> Result<Value, CardsError> {
    if !cards.config.new_activation_enabled {
        return Err(super::activation::gate_error());
    }
    if !caller.is_owner_session() {
        return Err(CardsError::forbidden("Owner session required"));
    }
    operation_id(&body.client_operation_id)?;
    let label = body.label.trim().to_owned();
    if label.is_empty() || label.chars().count() > 40 {
        return Err(CardsError::bad("label", "label must be 1-40 characters"));
    }
    let owner: Address = caller
        .wallet
        .parse()
        .map_err(|_| CardsError::forbidden("Owner wallet is not a Solana address"))?;
    let mut card_id = [0u8; 32];
    getrandom::fill(&mut card_id).expect("randomness");
    let claim_id = format!(
        "card-prepare:v1:{}:{}",
        caller.wallet, body.client_operation_id
    );
    let label_digest = program::hex(&Sha256::digest(label.as_bytes()));
    let (won, _, stored, initial) = cards
        .store
        .claim_operation(
            &claim_id,
            &caller.wallet,
            json!({"label": label_digest}),
            json!({"cardId": program::hex(&card_id)}),
        )
        .await?;
    if !won {
        if stored["label"] != label_digest {
            return Err(CardsError::conflict(
                "operation_reused",
                "clientOperationId was already used for a different card",
            ));
        }
        card_id = initial["cardId"]
            .as_str()
            .and_then(program::unhex::<32>)
            .ok_or_else(CardsError::internal)?;
        if let Some(card) = cards.card(&program::hex(&card_id)).await? {
            let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
            let salt = program::unhex::<32>(&issuer.ref_salt).ok_or_else(CardsError::internal)?;
            return Ok(prepared(
                cards,
                &owner,
                &card_id,
                &program::issuer_card_ref_hash(&issuer.card_token, &salt),
                blockhash,
            ));
        }
    }
    let issued = cards.lithic.create_card("ChainPay agent card").await.map_err(|error| match error {
        super::lithic::LithicError::WritesDisabled => CardsError::unavailable("issuer_writes_disabled", "Issuer writes are disabled on this deployment"),
        _ => CardsError::unavailable("issuer_unavailable", "The issuer sandbox could not create the card; retry with the same clientOperationId"),
    })?;
    let mut salt = [0u8; 32];
    getrandom::fill(&mut salt).expect("randomness");
    let card_ref_hash = program::issuer_card_ref_hash(&issued.token, &salt);
    let card_hex = program::hex(&card_id);
    let key = card_key(&card_hex);
    let accounts = CardAccounts::derive(&owner, &card_id);
    let secret = CardIssuerSecret {
        card_token: issued.token.clone(),
        last_four: issued.last_four.clone(),
        ref_salt: program::hex(&salt),
    };
    let record = json!({
        "v": 1,
        "type": "card",
        "cardId": card_hex,
        "bindingPda": accounts.binding.to_string(),
        "policyPda": accounts.policy.to_string(),
        "periodPda": accounts.period.to_string(),
        "commitmentPda": accounts.commitment.to_string(),
        "escrowPda": accounts.escrow.to_string(),
        "programId": program::CARD_POLICY_PROGRAM_ID,
        "cluster": "devnet",
        "issuerKind": "lithic_sandbox",
        "createdAt": rfc3339(now_ms()),
        "issuerState": issued.state,
        "mirror": {"state": "pending"},
        "freeze": {"onChain": false, "issuer": "confirmed"},
        "issuer": cards.crypto.seal_json(CardKind::Cards.as_str(), &key, &secret),
        "label": cards.crypto.seal_json(CardKind::Cards.as_str(), &key, &label),
    });
    let index = CardIndex {
        owner: Some(caller.wallet.clone()),
        connector: Some(CONNECTOR.into()),
        reference: Some(CARD_LIST_REFERENCE.into()),
        idempotency: Some(program::card_reference(&issued.token)),
    };
    if let CardPut::Conflict(existing) = cards
        .store
        .put_card_record(CardKind::Cards, &key, index, record, None, updated_now())
        .await?
    {
        // A concurrent retry stored this card first. Answer from the stored
        // row so the binding commits the card ChainPay actually keeps; the
        // extra Lithic card stays PAUSED and unbound.
        super::card_log!(
            "prepare raced for card {}; orphan issuer card left paused",
            log_id(&card_hex)
        );
        let existing = existing.ok_or_else(CardsError::internal)?;
        let issuer = cards
            .card_issuer(&existing)
            .ok_or_else(CardsError::internal)?;
        let salt = program::unhex::<32>(&issuer.ref_salt).ok_or_else(CardsError::internal)?;
        return Ok(prepared(
            cards,
            &owner,
            &card_id,
            &program::issuer_card_ref_hash(&issuer.card_token, &salt),
            blockhash,
        ));
    }
    super::card_log!("prepared card {}", log_id(&card_hex));
    Ok(prepared(cards, &owner, &card_id, &card_ref_hash, blockhash))
}

// ----------------------------------------------------------------- activate

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VersionedRequest {
    pub client_operation_id: String,
    pub expected_policy_version: u32,
}

pub(super) async fn read_policy(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Result<program::CardPolicyAccount, CardsError> {
    let (policy, _) = card_pdas(card)?;
    match cards.per.read(&policy, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => {
            let decoded = program::decode_policy(&data).map_err(|_| CardsError::internal())?;
            if decoded.binding.to_string() != card.record["bindingPda"].as_str().unwrap_or("") {
                return Err(CardsError::internal());
            }
            Ok(decoded)
        }
        TeeRead::NotVisible { .. } => Err(CardsError::conflict(
            "policy_not_visible",
            "The card's private policy is not readable by ChainPay's authorizer yet. Sign init_permission and set_policy first.",
        )),
        TeeRead::RpcError(_) => Err(CardsError::unavailable(
            "per_unavailable",
            "The private rollup is unreachable; retry",
        )),
    }
}

/// Read the card's period index from PER (the checkpoint's expected period).
async fn read_period_index(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Result<u32, CardsError> {
    let (_, period) = card_pdas(card)?;
    match cards.per.read(&period, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => Ok(program::decode_period(&data)
            .map_err(|_| CardsError::internal())?
            .period_index),
        TeeRead::NotVisible { .. } => Err(CardsError::conflict(
            "policy_not_visible",
            "The card's private state is not readable by ChainPay's authorizer",
        )),
        TeeRead::RpcError(_) => Err(CardsError::unavailable(
            "per_unavailable",
            "The private rollup is unreachable; retry",
        )),
    }
}

/// `POST /v1/cards/{cardId}/activate`, see [`super::activation`].
pub async fn activate(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: VersionedRequest,
) -> Result<Value, CardsError> {
    super::activation::activate(cards, caller, card_id, body).await
}

/// Stored checkpoint state for a PER submit outcome. `None`: refused as
/// stale, so PER must be read to know whether it took this seq.
pub fn checkpoint_outcome(outcome: &TxOutcome) -> Option<&'static str> {
    match outcome {
        TxOutcome::Confirmed { .. } => Some("scheduled"),
        // May have landed: the repair phase reads PER before resubmitting.
        TxOutcome::Unknown { .. } => Some("pending"),
        TxOutcome::ProgramError { code, .. }
            if program::error_name(*code) == Some("StaleCommitment") =>
        {
            None
        }
        _ => Some("failed"),
    }
}

/// Schedule a `CardCommitment` checkpoint for the card's current private
/// state and return the stored commitment record. The master salt is stored
/// only encrypted (contracts.md §1.6) so the owner can disclose single leaves.
///
/// `scheduled` means PER accepted the checkpoint and scheduled the base-layer
/// `write_commitment`; it is **not** a public commitment until
/// [`super::activation::repair_commitment`] reads it back (`confirmed`). An
/// unknown outcome is `pending` (PER may still have taken it), never `failed`.
/// A storage failure is an error, never a silent success.
pub async fn checkpoint(
    cards: &CardsConnector,
    card: &StoredCardRecord,
) -> Result<Value, CardsError> {
    let policy = read_policy(cards, card).await?;
    let period_index = read_period_index(cards, card).await?;
    let owner: Address = card
        .index
        .owner
        .as_deref()
        .and_then(|o| o.parse().ok())
        .ok_or_else(CardsError::internal)?;
    let card_id = program::unhex::<32>(card.record["cardId"].as_str().unwrap_or(""))
        .ok_or_else(CardsError::internal)?;
    let accounts = CardAccounts::derive(&owner, &card_id);
    // `commit_seq + 1`: the same seq again when an earlier attempt never
    // reached PER, the next one when it did.
    let seq = policy.commit_seq + 1;
    let mut salt = [0u8; 32];
    getrandom::fill(&mut salt).expect("randomness");
    let card_hex = program::hex(&card_id);
    let key = format!("salt:{card_hex}:{seq:020}");
    let record = json!({"v": 1, "type": "checkpoint_salt", "cardId": card_hex, "commitSeq": seq, "masterSalt": cards.crypto.seal_json(CardKind::CardRecovery.as_str(), &key, &program::hex(&salt))});
    let index = CardIndex {
        owner: card.index.owner.clone(),
        connector: Some(CONNECTOR.into()),
        reference: Some(card_hex.clone()),
        idempotency: None,
    };
    if let CardPut::Conflict(Some(existing)) = cards
        .store
        .put_card_record(
            CardKind::CardRecovery,
            &key,
            index,
            record,
            None,
            updated_now(),
        )
        .await?
    {
        // A previous attempt at this seq stored its salt: reuse it so the
        // stored salt always matches whatever lands on-chain.
        let stored: String = cards
            .crypto
            .open_json(
                CardKind::CardRecovery.as_str(),
                &key,
                &existing.record["masterSalt"],
            )
            .map_err(|_| CardsError::internal())?;
        salt = program::unhex::<32>(&stored).ok_or_else(CardsError::internal)?;
    }
    let previous = card.record["commitment"].clone();
    let attempts = if previous["seq"].as_str() == Some(seq.to_string().as_str()) {
        previous["attempts"].as_u64().unwrap_or(1) + 1
    } else {
        1
    };
    let mut commitment = json!({
        "seq": seq.to_string(),
        "state": "pending",
        "policyVersion": policy.policy_version,
        "periodIndex": period_index,
        "requestedAt": rfc3339(now_ms()),
        "attempts": attempts,
    });
    // The expectation is stored before the submit, so a crash in between
    // leaves a record the reconcile repair phase re-drives.
    cards
        .update_card(&card_hex, |record| {
            if record["commitment"]["state"] == "confirmed" {
                record["commitmentConfirmed"] = record["commitment"].clone();
            }
            record["commitment"] = commitment.clone();
            record["checkpointDue"] = Value::Null;
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    let outcome = cards
        .per
        .submit(
            vec![program::checkpoint(
                &cards.authorizer(),
                &accounts,
                &salt,
                seq,
            )],
            Instant::now() + Duration::from_secs(8),
        )
        .await;
    let state = match checkpoint_outcome(&outcome) {
        Some(state) => state,
        // PER is already past this seq: it took this checkpoint (same sealed
        // salt) or a concurrent one, or it did not.
        None => match read_policy(cards, card).await {
            Ok(p) if p.commit_seq >= seq => "scheduled",
            Ok(_) => "failed",
            Err(_) => "pending",
        },
    };
    commitment["state"] = json!(state);
    if state == "scheduled" {
        commitment["scheduledAt"] = json!(rfc3339(now_ms()));
    }
    if let Some(signature) = outcome.signature() {
        commitment["perTx"] = json!(signature);
    }
    cards
        .update_card(&card_hex, |record| {
            record["commitment"] = commitment.clone();
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    if state == "failed" {
        super::card_log!("checkpoint refused for card {}", log_id(&card_hex));
    }
    Ok(commitment)
}

// ------------------------------------------------------------------- freeze

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FreezeRequest {
    pub client_operation_id: String,
    pub reason: String,
}

/// `POST /v1/cards/{cardId}/freeze`: authorizer `freeze` on PER **and**
/// Lithic `PAUSED`; the issuer acknowledgement is recorded as `freeze_ack`.
pub async fn freeze(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: FreezeRequest,
) -> Result<Value, CardsError> {
    operation_id(&body.client_operation_id)?;
    if body.reason.trim().is_empty() || body.reason.chars().count() > 200 {
        return Err(CardsError::bad("reason", "reason must be 1-200 characters"));
    }
    let card = owned_card(cards, caller, card_id).await?;
    let op = format!("card-freeze:v1:{card_id}:{}", body.client_operation_id);
    let (won, _, _, _) = cards
        .store
        .claim_operation(
            &op,
            &caller.wallet,
            json!({"cardId": card_id}),
            json!({"state": "submitted"}),
        )
        .await?;
    let op_id = program::hex(&Sha256::digest(op.as_bytes())[..16]);
    let result = json!({"freezeOperationId": op_id, "onChain": "submitted", "issuer": "pending_issuer_confirmation"});
    // The claim only names the operation. A retry with the same id redoes
    // any half of the freeze that is not confirmed yet (PER `freeze` and
    // Lithic PAUSED are both idempotent), so an early failure never leaves
    // the card open while the client is told "submitted".
    if !won
        && card.record["freeze"]["opId"] == op_id.as_str()
        && card.record["freeze"]["onChainState"] == "confirmed"
        && card.record["freeze"]["issuer"] == "confirmed"
    {
        return Ok(result);
    }
    let (policy, period) = card_pdas(&card)?;
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let at = rfc3339(now_ms());
    cards
        .update_card(card_id, |record| {
            record["freeze"] = json!({"onChain": true, "issuer": "pending_issuer_confirmation", "wantedIssuerState": "PAUSED", "opId": op_id, "at": at});
        })
        .await?;
    let (per, lithic) = tokio::join!(
        cards.per.submit(
            vec![program::freeze(
                &cards.authorizer(),
                &policy,
                &period,
                program::FREEZE_AUTHORIZER_SAFETY
            )],
            Instant::now() + Duration::from_secs(8)
        ),
        cards.lithic.set_state(&issuer.card_token, "PAUSED"),
    );
    let on_chain = match &per {
        TxOutcome::Confirmed { .. } => "confirmed",
        TxOutcome::Unknown { .. } => "unknown",
        _ => "failed",
    };
    let issuer_state = match &lithic {
        Ok(card) if card.state == "PAUSED" => "confirmed",
        Ok(_) | Err(_) => "pending_issuer_confirmation",
    };
    let ack_at = rfc3339(now_ms());
    // The freeze itself already ran; a storage failure here is reported (the
    // client retries the same operation, which re-drives both halves).
    cards
        .update_card(card_id, |record| {
            record["freeze"]["onChainState"] = json!(on_chain);
            record["freeze"]["perTx"] = json!(per.signature());
            if issuer_state == "confirmed" {
                record["freeze"]["issuer"] = json!("confirmed");
                record["freeze"]["ackAt"] = json!(ack_at);
                record["freeze"]["ackSource"] = json!("patch_200");
                record["issuerState"] = json!("PAUSED");
            }
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    if issuer_state == "confirmed" {
        cards.metrics.count("freeze_acks");
    }
    record_activity(
        cards,
        &card,
        "freeze",
        json!({"onChain": on_chain, "issuer": issuer_state, "opId": op_id}),
    )
    .await;
    super::card_log!(
        "freeze {} per={on_chain} issuer={issuer_state}",
        log_id(card_id)
    );
    Ok(result)
}

/// `POST /v1/cards/{cardId}/unfreeze-mirror`: only after the **owner**
/// signed `unfreeze` on PER. Verifies `frozen == false`, then reopens Lithic.
pub async fn unfreeze_mirror(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: VersionedRequest,
) -> Result<Value, CardsError> {
    operation_id(&body.client_operation_id)?;
    let card = owned_card(cards, caller, card_id).await?;
    let policy = read_policy(cards, &card).await?;
    if policy.frozen || policy.recovery_state != 0 {
        return Err(CardsError::conflict(
            "still_frozen",
            "The card is still frozen on the private rollup; sign unfreeze first",
        ));
    }
    if policy.policy_version != body.expected_policy_version {
        return Err(CardsError::conflict(
            "policy_version",
            "The card's policy version changed; review it again",
        ));
    }
    if card.record["mirror"]["state"] != "acknowledged"
        || card.record["mirror"]["policyVersion"].as_u64() != Some(policy.policy_version as u64)
    {
        return Err(CardsError::conflict(
            "mirror_stale",
            "Activate the current policy before reopening the card",
        ));
    }
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let opened = cards.lithic.set_state(&issuer.card_token, "OPEN").await;
    let at = rfc3339(now_ms());
    let confirmed = matches!(&opened, Ok(c) if c.state == "OPEN");
    let updated = cards
        .update_card(card_id, |record| {
            record["freeze"] = json!({"onChain": false, "issuer": if confirmed { "confirmed" } else { "pending_issuer_confirmation" }, "wantedIssuerState": "OPEN", "at": at, "ackAt": if confirmed { json!(at) } else { Value::Null }});
            if confirmed {
                record["issuerState"] = json!("OPEN");
            }
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    record_activity(
        cards,
        &card,
        "unfreeze",
        json!({"issuer": if confirmed { "confirmed" } else { "pending" }}),
    )
    .await;
    Ok(card_view(
        cards,
        &updated,
        None,
        Some(&cards.attestation().await),
    ))
}

pub(super) async fn record_activity(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    kind: &str,
    detail: Value,
) {
    let mut id = [0u8; 12];
    getrandom::fill(&mut id).expect("randomness");
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let key = format!("mirror:{}", program::hex(&id));
    let record = json!({"v": 1, "type": "mirror", "kind": kind, "cardId": card_id, "detail": detail, "at": rfc3339(now_ms())});
    // The activity row is the owner's history, not state: a failed write is
    // logged and counted, and never fails the operation it describes.
    if let Err(error) = cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &key,
            CardsConnector::txn_index(card.index.owner.as_deref().unwrap_or(""), card_id),
            record,
            None,
            updated_now(),
        )
        .await
    {
        super::card_log!(
            "activity row not stored for card {}: {error}",
            log_id(card_id)
        );
        cards.metrics.count("activity_writes_failed");
    }
}

// ------------------------------------------------------------------- embed

/// `POST /v1/cards/{cardId}/embed-session`: Lithic's hosted iframe is the only
/// human display of the card number. Owner session only.
pub async fn embed_session(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
) -> Result<Value, CardsError> {
    let card = owned_card(cards, caller, card_id).await?;
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let session = cards
        .lithic
        .embed_session(&issuer.card_token, cards.config.embed_origin.as_deref())
        .await
        .map_err(|_| {
            CardsError::unavailable(
                "issuer_unavailable",
                "The issuer could not open a card display session",
            )
        })?;
    let mut url = reqwest::Url::parse(&format!("{}/v1/embed", cards.lithic.base()))
        .map_err(|_| CardsError::internal())?;
    url.query_pairs_mut()
        .append_pair("session", &session)
        .append_pair("type", "PAN");
    Ok(json!({"embedUrl": url.to_string(), "expiresAt": rfc3339(now_ms() + 600_000)}))
}

// ---------------------------------------------------------------- activity

fn lifecycle_row(
    cards: &CardsConnector,
    row: &StoredCardRecord,
    agent_view: bool,
) -> Option<Value> {
    let r = &row.record;
    let at = r["updatedAt"]
        .as_str()
        .or(r["receivedAt"].as_str())
        .or(r["at"].as_str())
        .unwrap_or("");
    match r["type"].as_str()? {
        "transaction" => {
            let provider = cards.open_provider(row);
            let acceptor = provider["merchant"]["acceptorId"].as_str().unwrap_or("");
            let display = merchant_by_acceptor(acceptor)
                .map(|m| m.display_name.to_owned())
                .unwrap_or_else(|| {
                    provider["merchant"]["descriptor"]
                        .as_str()
                        .unwrap_or("Merchant")
                        .to_owned()
                });
            let mcc = provider["merchant"]["mcc"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let state = r["state"].as_str().unwrap_or("pending");
            let flags = &r["flags"];
            let (kind, lifecycle) = match state {
                "forced_capture" => ("exception", "forced_capture"),
                "refunded" => ("refund", "refunded"),
                "captured" | "partially_captured" if flags["refunded"] == true => {
                    ("refund", "refunded")
                }
                "captured" | "partially_captured" if flags["lateCapture"] == true => {
                    ("capture", "late_capture")
                }
                "captured" => ("capture", "captured"),
                "partially_captured" => ("capture", "partially_captured"),
                "reversed" if flags["lateCapture"] == true => ("capture", "late_capture"),
                "reversed" => ("reversal", "reversed"),
                "expired" => ("reversal", "expired"),
                "declined" | "declined_internal" => ("authorization", "declined"),
                "ambiguous" => ("authorization", "ambiguous"),
                "account_verification" => ("authorization", "reserved"),
                "unsolicited" => ("exception", "pending"),
                _ => (
                    "authorization",
                    if state == "reserved" {
                        "reserved"
                    } else {
                        "pending"
                    },
                ),
            };
            let amount = match kind {
                "capture" | "exception" => r["capturedCents"].as_str(),
                "refund" => r["refundedCents"].as_str(),
                "reversal" => r["reversedCents"].as_str(),
                _ => r["amountCents"].as_str(),
            }
            .filter(|a| *a != "0")
            .or(r["amountCents"].as_str())
            .unwrap_or("0");
            let mut out = json!({
                "rowId": row.key,
                "cardId": r["cardId"],
                "at": at,
                "kind": kind,
                "lifecycle": lifecycle,
                "amountCents": amount,
                "merchant": {"displayName": display, "mcc": mcc},
                "needsReview": r["needsReview"].as_bool().unwrap_or(false) || r["exception"].is_string(),
            });
            if let Some(intent) = r["intentId"].as_str() {
                out["intentId"] = json!(intent);
            }
            if let Some(reason) = r["decision"]["reason"]
                .as_str()
                .filter(|_| matches!(state, "declined" | "declined_internal" | "ambiguous"))
            {
                out["declineReason"] = json!(reason);
            }
            if let Some(exception) = r["exception"].as_str() {
                out["exception"] = json!(exception);
            }
            if !agent_view {
                // Event reference the owner passes to `resolve_exception`.
                if let Some(id) = r["exceptionEventId"].as_str() {
                    out["eventIdHash"] = json!(id);
                }
                out["reservedCents"] = r["reservedCents"].clone();
                out["capturedCents"] = r["capturedCents"].clone();
                out["refundedCents"] = r["refundedCents"].clone();
                out["disputeState"] = r["disputeState"].clone();
            }
            Some(out)
        }
        "mirror" => {
            let kind = match r["kind"].as_str()? {
                "freeze" => "freeze",
                "unfreeze" => "unfreeze",
                _ => "policy_change",
            };
            Some(
                json!({"rowId": row.key, "cardId": r["cardId"], "at": at, "kind": kind, "needsReview": false}),
            )
        }
        _ => None,
    }
}

/// `GET /v1/cards/{cardId}/activity`: decrypted projection of the card's
/// transaction lifecycle rows, newest first, cursor = `updated` column.
pub async fn activity(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<Value, CardsError> {
    let card = readable_card(cards, caller, card_id, "get_card_activity").await?;
    let limit = limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(CardsError::bad("limit", "limit must be 1-100"));
    }
    if cursor.is_some_and(|c| c.len() != 20 || !c.bytes().all(|b| b.is_ascii_digit())) {
        return Err(CardsError::bad("cursor", "Invalid cursor"));
    }
    let owner = card.index.owner.clone().unwrap_or_default();
    let rows = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardEvents,
            &owner,
            CONNECTOR,
            card_id,
            cursor,
            limit,
        )
        .await?;
    let next = (rows.len() as u32 == limit)
        .then(|| rows.last().map(|r| r.updated.clone()))
        .flatten();
    let agent_view = !caller.is_owner_session();
    let projected: Vec<Value> = rows
        .iter()
        .filter_map(|row| lifecycle_row(cards, row, agent_view))
        .collect();
    Ok(json!({"rows": projected, "nextCursor": next}))
}

// --------------------------------------------------------------- statements

pub async fn statements(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
) -> Result<Value, CardsError> {
    super::statements::list(cards, caller, card_id).await
}

pub async fn statement(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    statement_id: &str,
) -> Result<Value, CardsError> {
    super::statements::get(cards, caller, card_id, statement_id).await
}

// ------------------------------------------------------- disclosure salts

/// `GET /v1/cards/{cardId}/disclosure-salt?seq=` (owner session only): the
/// checkpoint's master salt, so the owner's browser can build a field-picker
/// disclosure for that `CardCommitment` (contracts.md §1.6, §9). Never on a
/// scoped connection; the salt only ever goes to the card's owner.
pub async fn disclosure_salt(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    seq: Option<&str>,
    on_chain_seq: Option<u64>,
) -> Result<Value, CardsError> {
    let card = owned_card(cards, caller, card_id).await?;
    let seq: u64 = match seq {
        Some(value) => value
            .parse()
            .ok()
            .filter(|s| *s > 0)
            .ok_or_else(|| CardsError::bad("seq", "seq must be a positive integer"))?,
        None => on_chain_seq
            .filter(|s| *s > 0)
            .ok_or_else(|| CardsError::not_found("No checkpoint has landed for this card yet"))?,
    };
    let key = format!("salt:{card_id}:{seq:020}");
    let row = cards
        .store
        .get_card_record(CardKind::CardRecovery, &key)
        .await?
        .filter(|row| row.index.owner == card.index.owner)
        .ok_or_else(|| CardsError::not_found("No disclosure key exists for that checkpoint"))?;
    let salt: String = cards
        .crypto
        .open_json(
            CardKind::CardRecovery.as_str(),
            &key,
            &row.record["masterSalt"],
        )
        .map_err(|_| CardsError::internal())?;
    let state = match on_chain_seq {
        Some(current) if current == seq => "current",
        Some(current) if current > seq => "superseded",
        _ => "pending",
    };
    super::card_log!("disclosure salt served for card {}", log_id(card_id));
    Ok(
        json!({"cardId": card_id, "seq": seq.to_string(), "masterSalt": salt, "commitment": {"state": state, "onChainSeq": on_chain_seq.map(|s| s.to_string())}}),
    )
}

// ------------------------------------------------------------------ restore

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RestoreRequest {
    pub client_operation_id: String,
    #[serde(default)]
    pub recon_report_digest: Option<String>,
}

/// Canonical JSON (sorted keys, integers and strings only) for report digests.
pub fn canonical_digest(value: &Value) -> String {
    let text = serde_json::to_string(value).expect("json");
    program::hex(&Sha256::digest(
        format!("chainpay-card-recon:v1\n{text}").as_bytes(),
    ))
}

/// `POST /v1/cards/{cardId}/recovery/restore` (contracts.md §8). Without a
/// matching digest it returns the reconciliation report for review; with the
/// reviewed digest it returns the `restore` transaction co-signed by the
/// authorizer, for the owner to sign and send over their own PER session.
pub async fn restore(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: RestoreRequest,
) -> Result<Value, CardsError> {
    use base64::Engine;
    operation_id(&body.client_operation_id)?;
    let card = owned_card(cards, caller, card_id).await?;
    let (policy_pda, period_pda) = card_pdas(&card)?;
    // Fail closed: restore only a card PER shows as recovery-frozen, or one
    // whose private state is lost (not visible) and that ChainPay already
    // put in recovery.
    match cards.per.read(&policy_pda, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => {
            let policy = program::decode_policy(&data).map_err(|_| CardsError::internal())?;
            if policy.recovery_state != 1 {
                return Err(CardsError::conflict(
                    "not_in_recovery",
                    "This card is not recovery-frozen",
                ));
            }
        }
        TeeRead::NotVisible { .. } => {
            if !matches!(
                card.record["recovery"]["state"].as_str(),
                Some("recovery_frozen" | "restore_prepared")
            ) {
                return Err(CardsError::conflict(
                    "not_in_recovery",
                    "This card is not recovery-frozen",
                ));
            }
        }
        TeeRead::RpcError(_) => {
            return Err(CardsError::unavailable(
                "per_unavailable",
                "The private rollup is unreachable; retry",
            ));
        }
    }
    let owner = card.index.owner.clone().unwrap_or_default();
    let snapshots = cards
        .store
        .list_card_records_for_owner(CardKind::CardRecovery, &owner, CONNECTOR, card_id, None, 50)
        .await?;
    let latest = snapshots
        .iter()
        .filter(|row| row.record["type"] == "snapshot")
        .max_by_key(|row| row.record["ledgerSeq"].as_u64().unwrap_or(0))
        .ok_or_else(|| {
            CardsError::conflict("no_snapshot", "No recovery snapshot exists for this card")
        })?;
    let snapshot: Value = cards
        .crypto
        .open_json(
            CardKind::CardRecovery.as_str(),
            &latest.key,
            &latest.record["snapshot"],
        )
        .map_err(|_| CardsError::internal())?;
    let issuer = cards.card_issuer(&card).ok_or_else(CardsError::internal)?;
    let since = snapshot["takenAt"].as_str().map(str::to_owned);
    let truths = cards
        .lithic
        .list_transactions(&issuer.card_token, since.as_deref())
        .await
        .map_err(|_| {
            CardsError::unavailable("issuer_unavailable", "Issuer history is unavailable; retry")
        })?;
    if !truths.complete {
        // A partial history would make the reviewed report wrong.
        return Err(CardsError::unavailable(
            "issuer_history_incomplete",
            "Issuer history is longer than one review page; retry after reconciliation",
        ));
    }
    let issuer_events: Vec<Value> = truths
        .transactions
        .iter()
        .map(|t| {
            json!({
                "transaction": t["token"],
                "status": t["status"],
                "events": t["events"].as_array().map(|events| events.iter().map(|e| json!({"type": e["type"], "result": e["result"], "amountCents": cents(e["amount"].as_i64().unwrap_or(0).unsigned_abs())})).collect::<Vec<_>>()).unwrap_or_default(),
            })
        })
        .collect();
    // Snapshot + everything ChainPay booked since (never a reset to zero).
    let restored = super::recovery::restored_numbers(cards, &card, &snapshot).await?;
    let report = json!({"v": 1, "cardId": card_id, "snapshotLedgerSeq": latest.record["ledgerSeq"], "snapshot": snapshot, "issuerSinceSnapshot": issuer_events, "restore": restored});
    let digest = canonical_digest(&report);
    // Every value `restore` writes, keyed, so the owner's browser can check the
    // co-signed transaction against exactly what it showed (frontend
    // RECOVERY_NUMBER_KEYS). The budget comes from the snapshot's policy.
    let numbers = recovery_numbers(&snapshot["policy"]["budgetCents"], &restored);
    let recovery = &card.record["recovery"];
    let summary = json!({
        "digest": digest,
        "detectedAt": recovery["detectedAt"].as_str().unwrap_or(""),
        "reason": recovery["reason"].as_str().unwrap_or("unknown"),
        "snapshotLedgerSeq": latest.record["ledgerSeq"].as_u64().unwrap_or(0).to_string(),
        "issuerEventsReplayed": issuer_events.len(),
        "issuerTransactionsSinceSnapshot": issuer_events.len(),
        "postingsSinceSnapshot": restored["postingsSinceSnapshot"],
        "numbers": numbers,
    });
    let sealed = cards
        .crypto
        .seal_json(CardKind::Cards.as_str(), &card_key(card_id), &summary);
    if body.recon_report_digest.as_deref() != Some(digest.as_str()) {
        cards
            .update_card(card_id, |record| record["recoveryReport"] = sealed.clone())
            .await?
            .ok_or_else(CardsError::internal)?;
        return Ok(
            json!({"state": "review_required", "reconReport": report, "reconReportDigest": digest}),
        );
    }
    let p = &snapshot["policy"];
    let cents_of =
        |v: &Value| parse_cents(v.as_str().unwrap_or("")).ok_or_else(CardsError::internal);
    let args = program::RestoreArgs {
        policy: program::PolicyArgs {
            budget_cents: cents_of(&p["budgetCents"])?,
            max_purchase_cents: cents_of(&p["maxPurchaseCents"])?,
            max_purchases_per_period: p["maxPurchasesPerPeriod"].as_u64().unwrap_or(0) as u16,
            period_seconds: p["periodSeconds"].as_u64().unwrap_or(86_400) as u32,
            merchant_id_hashes: p["merchantIdHashes"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|h| h.as_str().and_then(program::unhex::<32>))
                        .collect()
                })
                .unwrap_or_default(),
            mccs: p["mccs"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|m| m.as_u64().map(|m| m as u16))
                        .collect()
                })
                .unwrap_or_default(),
            expires_at: p["expiresAt"].as_i64().unwrap_or(0),
            recurring_allowed: p["recurringAllowed"].as_bool().unwrap_or(false),
            fee_bps: p["feeBps"].as_u64().unwrap_or(0) as u16,
            authorizer: cards.authorizer().to_bytes(),
        },
        period_index: restored["periodIndex"].as_u64().unwrap_or(0) as u32,
        captured_cents: cents_of(&restored["capturedCents"])?,
        reserved_cents: cents_of(&restored["reservedCents"])?,
        refunded_cents: cents_of(&restored["refundedCents"])?,
        purchases_count: restored["purchasesCount"].as_u64().unwrap_or(0) as u16,
        exception_cents: cents_of(&restored["exceptionCents"])?,
        statement_outstanding_cents: cents_of(&restored["statementOutstandingCents"])?,
        ledger_head: restored["ledgerHead"]
            .as_str()
            .and_then(program::unhex::<32>)
            .ok_or_else(CardsError::internal)?,
        ledger_seq: restored["ledgerSeq"].as_u64().unwrap_or(0),
        recon_digest: program::unhex::<32>(&digest).ok_or_else(CardsError::internal)?,
    };
    let owner_key: Address = owner.parse().map_err(|_| CardsError::internal())?;
    let blockhash = cards.per.blockhash().await.ok_or_else(|| {
        CardsError::unavailable(
            "per_unavailable",
            "The private rollup is unreachable; retry",
        )
    })?;
    let instruction = program::restore(
        &owner_key,
        &cards.authorizer(),
        &policy_pda,
        &period_pda,
        &args,
    );
    let mut tx = program::unsigned_transaction(&owner_key, &[instruction], blockhash);
    program::sign_transaction(&mut tx, &[cards.per.signing_key()])
        .map_err(|_| CardsError::internal())?;
    // Recorded before the co-signed transaction is handed out.
    cards
        .update_card(card_id, |record| {
            record["recovery"]["state"] = json!("restore_prepared");
            record["recovery"]["reconDigest"] = json!(digest);
            record["recoveryReport"] = sealed.clone();
        })
        .await?
        .ok_or_else(CardsError::internal)?;
    let policy_args = &args.policy;
    Ok(json!({
        "state": "ready_to_sign",
        "reconReportDigest": digest,
        "restoreTx": base64::engine::general_purpose::STANDARD.encode(program::serialize_transaction(&tx)),
        "coSignedBy": cards.authorizer().to_string(),
        // RestoreArgs exactly as signed: cents as strings, hashes as hex.
        "restoreArgs": {
            "policy": {
                "budgetCents": cents(policy_args.budget_cents),
                "maxPurchaseCents": cents(policy_args.max_purchase_cents),
                "maxPurchasesPerPeriod": policy_args.max_purchases_per_period,
                "periodSeconds": policy_args.period_seconds,
                "merchantIdHashes": policy_args.merchant_id_hashes.iter().map(|h| program::hex(h)).collect::<Vec<_>>(),
                "mccs": policy_args.mccs,
                "expiresAt": policy_args.expires_at.to_string(),
                "recurringAllowed": policy_args.recurring_allowed,
                "feeBps": policy_args.fee_bps,
                "authorizer": cards.authorizer().to_string(),
            },
            "periodIndex": args.period_index,
            "capturedCents": cents(args.captured_cents),
            "reservedCents": cents(args.reserved_cents),
            "refundedCents": cents(args.refunded_cents),
            "purchasesCount": args.purchases_count,
            "exceptionCents": cents(args.exception_cents),
            "statementOutstandingCents": cents(args.statement_outstanding_cents),
            "ledgerHead": program::hex(&args.ledger_head),
            "ledgerSeq": args.ledger_seq.to_string(),
            "reconDigest": digest,
        },
    }))
}

/// Keyed recovery numbers for the owner's review (one per `restore` counter).
pub fn recovery_numbers(budget_cents: &Value, restored: &Value) -> Value {
    json!([
        {"key": "budget", "label": "Budget per period", "cents": budget_cents.as_str().unwrap_or("0")},
        {"key": "captured", "label": "Spent this period", "cents": restored["capturedCents"]},
        {"key": "reserved", "label": "Open holds", "cents": restored["reservedCents"]},
        {"key": "refunded", "label": "Refunds this period", "cents": restored["refundedCents"]},
        {"key": "exceptions", "label": "Flagged charges this period", "cents": restored["exceptionCents"]},
        {"key": "outstanding", "label": "Owed (simulated credit)", "cents": restored["statementOutstandingCents"]},
        {"key": "purchases", "label": "Purchases this period", "count": restored["purchasesCount"]},
    ])
}

// ------------------------------------------------------------------ misc

pub fn merchants() -> Value {
    json!({"merchants": super::MERCHANTS.iter().map(|m| json!({
        "merchantRef": m.reference,
        "displayName": m.display_name,
        "merchantIdHash": program::hex(&program::merchant_id_hash(m.acceptor_id)),
        "mcc": m.mcc,
    })).collect::<Vec<_>>()})
}

pub async fn list_cards(cards: &Arc<CardsConnector>, caller: &Caller) -> Result<Value, CardsError> {
    if !caller.is_owner_session() {
        return Err(CardsError::forbidden("Owner session required"));
    }
    let rows = cards
        .store
        .list_card_records_for_owner(
            CardKind::Cards,
            &caller.wallet,
            CONNECTOR,
            CARD_LIST_REFERENCE,
            None,
            50,
        )
        .await?;
    let attestation = cards.attestation().await;
    Ok(
        json!({"cards": rows.iter().map(|row| card_view(cards, row, None, Some(&attestation))).collect::<Vec<_>>()}),
    )
}

/// Constant-time bearer check for service routes (cron, checkout runner).
pub fn bearer_matches(header: Option<&str>, secret: Option<&str>) -> bool {
    let (Some(header), Some(secret)) = (header, secret) else {
        return false;
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    let a = Sha256::digest(token.as_bytes());
    let b = Sha256::digest(secret.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn an_unknown_checkpoint_is_pending_never_failed() {
        let sig = || Some("s".to_owned());
        assert_eq!(
            checkpoint_outcome(&TxOutcome::Confirmed {
                signature: "s".into()
            }),
            Some("scheduled")
        );
        assert_eq!(
            checkpoint_outcome(&TxOutcome::Unknown { signature: sig() }),
            Some("pending")
        );
        assert_eq!(
            checkpoint_outcome(&TxOutcome::Failed {
                signature: sig(),
                reason: "x".into()
            }),
            Some("failed")
        );
        let stale = 6000
            + program::ERRORS
                .iter()
                .position(|e| *e == "StaleCommitment")
                .unwrap() as u32;
        assert_eq!(
            checkpoint_outcome(&TxOutcome::ProgramError {
                signature: "s".into(),
                code: stale
            }),
            None
        );
    }

    #[test]
    fn bearer_checks_are_exact() {
        assert!(bearer_matches(
            Some("Bearer s3cret-value-123456"),
            Some("s3cret-value-123456")
        ));
        assert!(!bearer_matches(
            Some("Bearer s3cret-value-12345"),
            Some("s3cret-value-123456")
        ));
        assert!(!bearer_matches(
            Some("s3cret-value-123456"),
            Some("s3cret-value-123456")
        ));
        assert!(!bearer_matches(None, Some("x")));
        assert!(!bearer_matches(Some("Bearer x"), None));
    }

    #[test]
    fn recovery_numbers_cover_every_restored_counter() {
        let restored = json!({"capturedCents": "2000", "reservedCents": "0", "refundedCents": "0", "exceptionCents": "150", "statementOutstandingCents": "2010", "purchasesCount": 1});
        let numbers = recovery_numbers(&json!("10000"), &restored);
        let keys: Vec<&str> = numbers
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["key"].as_str().unwrap())
            .collect();
        assert_eq!(
            keys,
            [
                "budget",
                "captured",
                "reserved",
                "refunded",
                "exceptions",
                "outstanding",
                "purchases"
            ]
        );
        assert_eq!(numbers[0]["cents"], "10000");
        assert_eq!(numbers[4]["cents"], "150");
        assert_eq!(numbers[6]["count"], 1);
    }

    #[test]
    fn agent_identity_exists_only_for_scoped_connections() {
        let owner = Caller {
            wallet: "w".into(),
            scope: None,
            connection: Some("h".into()),
        };
        assert!(owner.agent_id().is_none());
        let agent = Caller {
            wallet: "w".into(),
            scope: Some(json!({"cards":["c"],"tools":["get_card_activity"]})),
            connection: Some("h".into()),
        };
        assert!(agent.agent_id().is_some());
        assert!(agent.scope_allows("c", "get_card_activity"));
        assert!(!agent.scope_allows("c", "request_card_checkout"));
        assert!(!agent.scope_allows("d", "get_card_activity"));
    }
}
