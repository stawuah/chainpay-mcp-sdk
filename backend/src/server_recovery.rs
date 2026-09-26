//! Durable intent reservation and bounded reconciliation. A retry never signs or sends again.
use super::*;

pub(super) fn intent(
    request: &PaymentSubmissionRequest,
    mode: SigningMode,
) -> Result<Value, ApiError> {
    let tx = decode_solana_transaction(
        &decode_transaction(&request.signed_transaction)?,
        "transaction",
    )?;
    Ok(
        json!({"mandate":request.mandate,"invoice":request.invoice_hash.to_lowercase(),"receipt":request.receipt_address,"agent":request.agent,"mint":request.mint,"recipient":request.recipient,"amount":request.amount.map(|v|v.to_string()),"token_program":request.token_program,"mode":mode,"message":hex_encode(&Sha256::digest(tx.message.serialize())),"x402":request.x402}),
    )
}
pub(super) fn initial(
    request: &PaymentSubmissionRequest,
    mode: SigningMode,
) -> Result<PaymentRecord, ApiError> {
    let signature = if mode == SigningMode::Human {
        Some(signature(&request.signed_transaction)?)
    } else {
        None
    };
    Ok(PaymentRecord {
        payment_id:deterministic_id("payment", &request.idempotency_key),idempotency_key:request.idempotency_key.clone(),mandate:request.mandate.clone(),invoice_hash:request.invoice_hash.clone(),receipt_address:request.receipt_address.clone(),agent:request.agent.clone(),mint:request.mint.clone(),recipient:Some(request.recipient.clone()),amount:request.amount,token_program:request.token_program.clone(),signing_mode:mode,signature,slot:None,status:PaymentStatus::Prepared,error:Some("Reserved and not yet sent. Retry this same request or recover with the original signed bytes; do not sign a replacement.".into()),created_at_ms:now_ms(),updated_at_ms:now_ms()
    })
}
pub(super) fn signature(encoded: &str) -> Result<String, ApiError> {
    let tx = decode_solana_transaction(&decode_transaction(encoded)?, "transaction")?;
    tx.signatures
        .first()
        .map(ToString::to_string)
        .ok_or_else(|| ApiError::BadRequest("Transaction has no signature".into()))
}
pub(super) fn conflict() -> ApiError {
    ApiError::Conflict("Idempotency key already binds a different immutable intent".into())
}
pub(super) async fn authorize_payment(
    state: &BackendState,
    principal: &Principal,
    record: &PaymentRecord,
    tool: &str,
) -> Result<(), ApiError> {
    if let Some(owner) = state.store.operation_owner(&record.payment_id).await? {
        if owner != principal.wallet {
            return Err(ApiError::Forbidden(
                "Operation belongs to another owner".into(),
            ));
        }
        if principal.scope.is_none() {
            return Ok(());
        }
    }
    auth::mandate(state, principal, &record.mandate, tool).await
}
pub(super) async fn existing_payment(
    state: &BackendState,
    principal: &Principal,
    request: &PaymentSubmissionRequest,
    mode: SigningMode,
) -> Result<Option<PaymentRecord>, ApiError> {
    // PR01 included mandate twice in its scoped key. Never create a new operation
    // merely because the namespace was tightened to detect changed mandates.
    let user_key = request
        .idempotency_key
        .strip_prefix(&format!("{}:", principal.wallet))
        .ok_or(ApiError::Unauthorized)?;
    let legacy_key = format!("{}:{}:{}", principal.wallet, request.mandate, user_key);
    if let Some(old) = state.store.find_payment_by_idempotency(&legacy_key).await? {
        authorize_payment(
            state,
            principal,
            &old,
            if request.x402.is_some() {
                "execute_x402_payment"
            } else {
                "execute_payment"
            },
        )
        .await?;
        return Err(ApiError::Conflict(format!(
            "Existing operation {} predates intent hashes; query that operation instead of submitting again",
            old.payment_id
        )));
    }
    let id = deterministic_id("payment", &request.idempotency_key);
    let Some((owner, bound, initial)) = state.store.operation_record(&id).await? else {
        if state.store.get_payment(&id).await?.is_some() {
            return Err(ApiError::Conflict(
                "Legacy operation has no authenticated intent reservation; use its status endpoint"
                    .into(),
            ));
        }
        return Ok(None);
    };
    if owner != principal.wallet {
        return Err(ApiError::Unauthorized);
    }
    if bound != intent(request, mode)? {
        return Err(conflict());
    }
    let record = match state.store.get_payment(&id).await? {
        Some(r) => r,
        None => serde_json::from_value(initial)
            .map_err(|_| ApiError::Conflict("Operation reservation needs recovery".into()))?,
    };
    authorize_payment(
        state,
        principal,
        &record,
        if request.x402.is_some() {
            "execute_x402_payment"
        } else {
            "execute_payment"
        },
    )
    .await?;
    Ok(Some(payment(state, record).await?))
}
pub(super) async fn reserve_payment(
    state: &BackendState,
    principal: &Principal,
    request: &PaymentSubmissionRequest,
    mode: SigningMode,
) -> Result<(bool, PaymentRecord), ApiError> {
    let record = initial(request, mode)?;
    let desired = intent(request, mode)?;
    let (won, owner, bound, initial) = state
        .store
        .claim_operation(
            &record.payment_id,
            &principal.wallet,
            desired.clone(),
            json!(record),
        )
        .await?;
    if owner != principal.wallet || bound != desired {
        return Err(conflict());
    }
    let existing = match state.store.get_payment(&record.payment_id).await? {
        Some(r) => r,
        None => serde_json::from_value(initial).map_err(|_| conflict())?,
    };
    Ok((won, existing))
}
fn deterministic_failure(error: &RpcError) -> bool {
    if matches!(error,RpcError::Remote{message,..} if message.to_ascii_lowercase().replace(' ', "").contains("alreadyprocessed"))
    {
        return false;
    }
    matches!(
        error,
        RpcError::TransactionFailed { .. }
            | RpcError::Remote {
                code: -32002 | -32003 | -32602,
                ..
            }
    )
}
/// Failures raised before any byte of the transaction left this process. These
/// are the only errors where non-transmission is *proven* rather than assumed,
/// so they are the only ones allowed to return a reservation to Prepared.
///
/// `RpcError::Busy` comes from `try_acquire` on the in-flight semaphore
/// (`rpc/mod.rs`), which runs ahead of the HTTP request. This is the opposite of
/// the ambiguity `docs/settlement-recovery.md` guards against: there we must not
/// assume a request never arrived, here we know it never left.
fn provably_unsent(error: &RpcError) -> bool {
    matches!(error, RpcError::Busy)
}

/// Return a reservation to Prepared so `known_unsent` re-sends the identical
/// signed bytes on the next attempt. The signature stays on the record as an
/// audit trail; it is recomputed from the same transaction when the retry runs.
fn unsent_record(mut record: PaymentRecord, error: &RpcError) -> PaymentRecord {
    record.status = PaymentStatus::Prepared;
    record.error = Some(error.to_string());
    record.updated_at_ms = now_ms();
    record
}

pub(super) fn known_unsent(record: &PaymentRecord) -> bool {
    record.status == PaymentStatus::Prepared
}
/// After a send attempt: never mark Failed while the original signature may exist on chain.
pub(super) async fn classify_send(
    state: &BackendState,
    record: PaymentRecord,
    error: &RpcError,
) -> Result<PaymentRecord, ApiError> {
    if provably_unsent(error) {
        return Ok(unsent_record(record, error));
    }
    let Some(signature) = record.signature.clone() else {
        return Ok(payment_error(record, error));
    };
    match state.rpc.signature_status(&signature).await {
        Ok(Some(_)) => {
            let mut record = record;
            record.status = PaymentStatus::Submitted;
            record.error = Some(
                "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into(),
            );
            record.updated_at_ms = now_ms();
            payment(state, record).await
        }
        Ok(None) if deterministic_failure(error) => Ok(payment_error(record, error)),
        Ok(None) | Err(_) => {
            let mut record = payment_error(record, error);
            record.status = PaymentStatus::Submitted;
            record.error = Some(
                "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into(),
            );
            record.updated_at_ms = now_ms();
            Ok(record)
        }
    }
}
pub(super) async fn classify_transaction_send(
    state: &BackendState,
    record: TransactionRecord,
    error: &RpcError,
) -> Result<TransactionRecord, ApiError> {
    if provably_unsent(error) {
        let mut record = record;
        record.status = PaymentStatus::Prepared;
        record.error = Some(error.to_string());
        record.updated_at_ms = now_ms();
        return Ok(record);
    }
    let Some(signature) = record.signature.clone() else {
        return Ok(transaction_error(record, error));
    };
    match state.rpc.signature_status(&signature).await {
        Ok(Some(_)) => {
            let mut record = record;
            record.status = PaymentStatus::Submitted;
            record.error = Some(
                "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into(),
            );
            record.updated_at_ms = now_ms();
            transaction(state, record).await
        }
        Ok(None) if deterministic_failure(error) => Ok(transaction_error(record, error)),
        Ok(None) | Err(_) => {
            let mut record = transaction_error(record, error);
            record.status = PaymentStatus::Submitted;
            record.error = Some(
                "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into(),
            );
            record.updated_at_ms = now_ms();
            Ok(record)
        }
    }
}
/// What to tell the owner when the chain or its preflight refused the
/// transaction.
///
/// The upstream reason is carried through rather than flattened, because a
/// stale blockhash, a failing instruction and a malformed signature are three
/// different problems with three different answers, and one shared sentence
/// makes every one of them look like the others. The message an RPC returns
/// here describes the transaction, not this process: credentials live in the
/// URL, which only `RpcError::Http` carries and which is stripped at
/// construction.
fn rejection_reason(error: &RpcError) -> String {
    const PREFIX: &str = "Transaction rejected by chain or preflight";
    let detail = match error {
        RpcError::Remote { message, .. } | RpcError::TransactionFailed { message, .. } => {
            message.trim()
        }
        _ => "",
    };
    if detail.is_empty() {
        return PREFIX.to_owned();
    }
    // Simulation failures arrive with their whole program log attached. The
    // first line names the error; the rest belongs in the explorer.
    let first_line = detail.lines().next().unwrap_or(detail).trim();
    let clipped: String = first_line.chars().take(200).collect();
    format!("{PREFIX}: {clipped}")
}
pub(super) fn payment_error(mut record: PaymentRecord, error: &RpcError) -> PaymentRecord {
    record.status = if deterministic_failure(error) {
        PaymentStatus::Failed
    } else {
        PaymentStatus::Submitted
    };
    record.error = Some(if deterministic_failure(error) {
        rejection_reason(error)
    } else {
        "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into()
    });
    record.updated_at_ms = now_ms();
    record
}
pub(super) fn transaction_error(
    mut record: TransactionRecord,
    error: &RpcError,
) -> TransactionRecord {
    record.status = if deterministic_failure(error) {
        PaymentStatus::Failed
    } else {
        PaymentStatus::Submitted
    };
    record.error = Some(if deterministic_failure(error) {
        rejection_reason(error)
    } else {
        "Submission outcome unknown; awaiting chain reconciliation. Keep this operation and signature.".into()
    });
    record.updated_at_ms = now_ms();
    record
}
pub(super) async fn payment(
    state: &BackendState,
    mut record: PaymentRecord,
) -> Result<PaymentRecord, ApiError> {
    if matches!(
        record.status,
        PaymentStatus::Confirmed | PaymentStatus::Failed
    ) {
        return Ok(record);
    }
    let Some(signature) = record.signature.clone() else {
        return Ok(record);
    };
    match state.rpc.signature_status(&signature).await {
        Ok(Some(status))
            if status.error.is_some()
                && status.confirmation_status.as_deref() == Some("finalized") =>
        {
            record.status = PaymentStatus::Failed;
            record.error = Some("Transaction failed on chain".into());
        }
        Ok(Some(status))
            if status.error.is_none()
                && status.confirmation_status.as_deref() == Some("finalized") =>
        {
            match verify_finalized_receipt(&state.rpc, &record, &state.config.program_id).await {
                Ok(()) => {
                    record.status = PaymentStatus::Confirmed;
                    record.slot = status.slot;
                    record.error = None;
                }
                Err(_) => {
                    record.status = PaymentStatus::Submitted;
                    record.error=Some("Transaction finalized; receipt verification pending. Do not create a replacement payment.".into());
                }
            }
        }
        _ => {
            if record.status != PaymentStatus::Prepared {
                record.status = PaymentStatus::Submitted;
                record.error = Some(
                    "Submission outcome pending chain reconciliation. Keep the existing operation."
                        .into(),
                );
            }
        }
    }
    record.updated_at_ms = now_ms();
    let x402 = state
        .store
        .find_x402_by_idempotency(&record.idempotency_key)
        .await?;
    let metadata = match x402 {
        Some(r) => Some(X402PaymentMetadata {
            resource: r.resource,
            challenge: r.challenge,
        }),
        None => state
            .store
            .operation_record(&record.payment_id)
            .await?
            .and_then(|(_, intent, _)| {
                serde_json::from_value::<Option<X402PaymentMetadata>>(intent["x402"].clone())
                    .ok()
                    .flatten()
            }),
    };
    persist_payment(state, &record, metadata.as_ref()).await?;
    Ok(state
        .store
        .get_payment(&record.payment_id)
        .await?
        .unwrap_or(record))
}
pub(super) async fn transaction(
    state: &BackendState,
    mut record: TransactionRecord,
) -> Result<TransactionRecord, ApiError> {
    if matches!(
        record.status,
        PaymentStatus::Confirmed | PaymentStatus::Failed
    ) {
        return Ok(record);
    }
    let Some(signature) = record.signature.clone() else {
        return Ok(record);
    };
    match state.rpc.signature_status(&signature).await {
        Ok(Some(status))
            if status.error.is_some()
                && status.confirmation_status.as_deref() == Some("finalized") =>
        {
            record.status = PaymentStatus::Failed;
            record.error = Some("Transaction failed on chain".into());
        }
        Ok(Some(status))
            if status.error.is_none()
                && status.confirmation_status.as_deref() == Some("finalized") =>
        {
            let mut verified = true;
            if let Some((_, intent, _)) =
                state.store.operation_record(&record.transaction_id).await?
            {
                if let Some(receipts) = intent["receipts"].as_array() {
                    for receipt in receipts {
                        let receipt: PaymentRecord =
                            serde_json::from_value(receipt.clone()).map_err(|_| conflict())?;
                        if verify_finalized_receipt(&state.rpc, &receipt, &state.config.program_id)
                            .await
                            .is_err()
                        {
                            verified = false;
                            break;
                        }
                    }
                }
            }
            if verified {
                record.status = PaymentStatus::Confirmed;
                record.slot = status.slot;
                record.error = None;
            } else {
                record.status = PaymentStatus::Submitted;
                record.error=Some("Transaction finalized; batch receipt verification pending. Keep the existing operation.".into());
            }
        }
        _ => {
            record.status = PaymentStatus::Submitted;
            record.error = Some(
                "Submission outcome pending chain reconciliation. Keep the existing operation."
                    .into(),
            );
        }
    }
    record.updated_at_ms = now_ms();
    state.store.put_transaction(record.clone()).await?;
    Ok(state
        .store
        .get_transaction(&record.transaction_id)
        .await?
        .unwrap_or(record))
}

pub(super) async fn recover_provision(
    state: &BackendState,
    owner: &str,
    mandate: &str,
) -> Result<ManagedSignerRecord, ApiError> {
    let id = deterministic_id("provision", &format!("{owner}:{mandate}"));
    let (reserved_owner, intent, _) =
        state.store.operation_record(&id).await?.ok_or_else(|| {
            ApiError::Conflict("No original authenticated enrollment reservation exists".into())
        })?;
    if reserved_owner != owner || intent["mandate"] != mandate {
        return Err(ApiError::Unauthorized);
    }
    if let Some(existing) = state.store.find_managed_signer_by_mandate(mandate).await? {
        if existing.owner_wallet != owner {
            return Err(ApiError::Unauthorized);
        }
        return Ok(existing);
    }
    let provider = state
        .signer_provider
        .as_ref()
        .ok_or(ApiError::ManagedSignerUnavailable)?;
    let recovered = match provider.lookup(owner, mandate).await {
        Ok(wallet) => wallet,
        Err(SignerProviderError::Remote { status, .. })
            if status == reqwest::StatusCode::NOT_FOUND =>
        {
            // Same immutable, app-unique external ID: even a delayed original
            // create cannot produce another identity (Privy's documented contract).
            match provider.provision(owner,mandate).await {
                Ok(wallet)=>wallet,
                Err(_)=>provider.lookup(owner,mandate).await.map_err(|_|ApiError::Conflict(format!("Provider identity {} remains uncertain. Retry the same enrollment lookup; never create another identity.",crate::signer::external_id(owner,mandate))))?,
            }
        }
        Err(_) => {
            return Err(ApiError::Conflict(format!(
                "Provider identity {} is not yet verifiable. Retry the same enrollment lookup; never create another identity.",
                crate::signer::external_id(owner, mandate)
            )));
        }
    };
    let now = now_ms();
    let signer = ManagedSignerRecord {
        signer_id: deterministic_id("signer", &id),
        owner_wallet: owner.into(),
        public_key: recovered.public_key,
        provider: "privy".into(),
        provider_wallet_id: recovered.provider_wallet_id,
        provider_policy_id: recovered.provider_policy_id,
        mandate_pda: mandate.into(),
        signing_mode: SigningMode::Delegated,
        status: ManagedSignerStatus::Provisioning,
        created_at_ms: now,
        updated_at_ms: now,
        revoked_at_ms: None,
    };
    state.store.put_managed_signer(signer.clone()).await?;
    Ok(signer)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoverSigned {
    signed_transaction: String,
    #[serde(default)]
    resubmit: bool,
}
async fn can_resubmit(
    state: &BackendState,
    signature: &str,
    tx: &VersionedTransaction,
) -> Result<bool, ApiError> {
    // Reconciliation must succeed. Unknown RPC state never authorizes a send.
    if state.rpc.signature_status(signature).await?.is_some() {
        return Ok(false);
    }
    if !state
        .rpc
        .blockhash_valid(&tx.message.recent_blockhash().to_string())
        .await?
    {
        return Err(ApiError::Conflict("Original blockhash expired. Do not sign a replacement: query archival signature/receipt evidence or contact the operator.".into()));
    }
    Ok(true)
}
pub(super) async fn recover_payment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<RecoverSigned>,
) -> Result<Json<PaymentRecord>, ApiError> {
    let (owner, bound, snapshot) = state
        .store
        .operation_record(&id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if owner != principal.wallet {
        return Err(ApiError::Unauthorized);
    }
    let mut record = match state.store.get_payment(&id).await? {
        Some(r) => r,
        None => serde_json::from_value(snapshot).map_err(|_| conflict())?,
    };
    authorize_payment(
        &state,
        &principal,
        &record,
        if bound["x402"].is_null() {
            "execute_payment"
        } else {
            "execute_x402_payment"
        },
    )
    .await?;
    let request = PaymentSubmissionRequest {
        idempotency_key: record.idempotency_key.clone(),
        mandate: record.mandate.clone(),
        invoice_hash: record.invoice_hash.clone(),
        receipt_address: record.receipt_address.clone(),
        signed_transaction: input.signed_transaction.clone(),
        agent: record.agent.clone(),
        mint: record.mint.clone(),
        recipient: record.recipient.clone().ok_or_else(conflict)?,
        amount: record.amount,
        token_program: record.token_program.clone(),
        x402: serde_json::from_value(bound["x402"].clone()).map_err(|_| conflict())?,
    };
    validate_payment_request(&request, &state.config.program_id)?;
    let tx = decode_solana_transaction(
        &decode_transaction(&input.signed_transaction)?,
        "recovered transaction",
    )?;
    if bound["message"] != hex_encode(&Sha256::digest(tx.message.serialize())) {
        return Err(conflict());
    }
    let signature = signature(&input.signed_transaction)?;
    if record
        .signature
        .as_ref()
        .is_some_and(|old| old != &signature)
    {
        return Err(conflict());
    }
    record.signature = Some(signature.clone());
    record.updated_at_ms = now_ms();
    persist_payment(&state, &record, request.x402.as_ref()).await?;
    record = payment(&state, record).await?;
    if input.resubmit
        && !matches!(
            record.status,
            PaymentStatus::Confirmed | PaymentStatus::Failed
        )
    {
        // Recovery of the historical operation is readable by the original owner;
        // rebroadcast still requires the current on-chain mandate and agent.
        auth::mandate(
            &state,
            &principal,
            &record.mandate,
            if request.x402.is_some() {
                "execute_x402_payment"
            } else {
                "execute_payment"
            },
        )
        .await?;
        validate_live_payment(&state, &request).await?;
        if can_resubmit(&state, &signature, &tx).await? {
            if state
                .rpc
                .send_transaction(&input.signed_transaction)
                .await
                .is_err()
            {
                record.status = PaymentStatus::Submitted;
                record.error =
                    Some("Recovery submission outcome unknown; retain the same signature.".into());
                record.updated_at_ms = now_ms();
                persist_payment(&state, &record, request.x402.as_ref()).await?;
            }
        }
    }
    Ok(Json(payment(&state, record).await?))
}
pub(super) async fn recover_transaction(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<RecoverSigned>,
) -> Result<Json<TransactionRecord>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    let (owner, bound, snapshot) = state
        .store
        .operation_record(&id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if owner != principal.wallet {
        return Err(ApiError::Unauthorized);
    }
    let mut record = match state.store.get_transaction(&id).await? {
        Some(r) => r,
        None => serde_json::from_value(snapshot).map_err(|_| conflict())?,
    };
    let tx = decode_solana_transaction(
        &decode_transaction(&input.signed_transaction)?,
        "recovered transaction",
    )?;
    validate_owner_transaction(&tx, &principal.wallet, &state.config.program_id)?;
    let signature = signature(&input.signed_transaction)?;
    if bound["message"] != hex_encode(&Sha256::digest(tx.message.serialize()))
        || record.signature.as_deref() != Some(&signature)
    {
        return Err(conflict());
    }
    record = transaction(&state, record).await?;
    if input.resubmit
        && !matches!(
            record.status,
            PaymentStatus::Confirmed | PaymentStatus::Failed
        )
    {
        validate_owner_live(&state, &principal, &tx).await?;
        if can_resubmit(&state, &signature, &tx).await? {
            let _ = state.rpc.send_transaction(&input.signed_transaction).await;
        }
    }
    Ok(Json(transaction(&state, record).await?))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CancelUnstarted {
    kind: String,
    key: String,
}
pub(super) async fn cancel_unstarted(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(input): Json<CancelUnstarted>,
) -> Result<Json<Value>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    validate_string(&input.key, "key")?;
    if !["payments", "transactions"].contains(&input.kind.as_str()) {
        return Err(ApiError::BadRequest("Unknown operation kind".into()));
    }
    let prefix = if input.kind == "payments" {
        "payment"
    } else {
        "transaction"
    };
    let key = format!("{}:{}", principal.wallet, input.key);
    let id = deterministic_id(prefix, &key);
    if state.store.get_payment(&id).await?.is_some()
        || state.store.get_transaction(&id).await?.is_some()
    {
        return Err(ApiError::Conflict(
            "Operation already exists; reconcile it".into(),
        ));
    }
    let intent = json!({"cancelled_before_reservation":true});
    let (_, owner, bound, _) = state
        .store
        .claim_operation(
            &id,
            &principal.wallet,
            intent.clone(),
            json!({"cancelled":true}),
        )
        .await?;
    if owner != principal.wallet || bound != intent {
        return Err(ApiError::Conflict(
            "Operation is already reserved; it cannot be canceled as unstarted".into(),
        ));
    }
    Ok(Json(
        json!({"operation_id":id,"cancelled":true,"message":"No submission may claim this key now. Existing approvals were not rebroadcast."}),
    ))
}

pub(super) async fn x402_context(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>, ApiError> {
    let record = state
        .store
        .get_payment(&id)
        .await?
        .ok_or(ApiError::NotFound)?;
    authorize_payment(&state, &principal, &record, "execute_x402_payment").await?;
    let record = payment(&state, record).await?;
    let metadata = state
        .store
        .find_x402_by_idempotency(&record.idempotency_key)
        .await?
        .ok_or(ApiError::NotFound)?;
    let key = record
        .idempotency_key
        .strip_prefix(&format!("{}:", principal.wallet))
        .ok_or(ApiError::Unauthorized)?;
    Ok(Json(
        json!({"payment":record,"resource":metadata.resource,"challenge":metadata.challenge,"idempotency_key":key,"merchant_status":metadata.status,"proof":metadata.proof}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn a_rejection_names_the_reason_the_chain_gave() {
        // A stale blockhash and a failing instruction are different problems.
        // Reporting both as "rejected" leaves the owner nothing to act on.
        assert_eq!(
            rejection_reason(&RpcError::Remote {
                method: "sendTransaction".to_owned(),
                message: "Blockhash not found".to_owned(),
                code: -32002,
            }),
            "Transaction rejected by chain or preflight: Blockhash not found"
        );

        // A simulation failure carries its whole program log. The first line
        // names the error; the rest belongs in an explorer, not a toast.
        assert_eq!(
            rejection_reason(&RpcError::TransactionFailed {
                signature: "sig".to_owned(),
                message: "Error processing Instruction 0: custom program error: 0x1\nProgram log: insufficient funds".to_owned(),
            }),
            "Transaction rejected by chain or preflight: Error processing Instruction 0: custom program error: 0x1"
        );

        // Errors that carry no upstream message keep the bare sentence rather
        // than inventing a reason or trailing an empty colon.
        assert_eq!(
            rejection_reason(&RpcError::MissingField("value")),
            "Transaction rejected by chain or preflight"
        );
    }

    fn fixture() -> (BackendState, Principal, PaymentSubmissionRequest) {
        let (_, mut request, _) = transactions::tests::fixture(0);
        let principal = Principal {
            wallet: request.agent.clone().unwrap(),
            scope: None,
        };
        request.idempotency_key = format!("{}:{}", principal.wallet, random_hex_32().unwrap());
        let state = BackendState::new(BackendConfig::from_env().unwrap(), StatusStore::in_memory())
            .unwrap();
        (state, principal, request)
    }
    #[tokio::test]
    async fn rpc_backpressure_returns_the_reservation_to_prepared() {
        // `RpcError::Busy` is raised by `try_acquire` before the HTTP request is
        // built, so the transaction provably never left the process. Leaving the
        // record Submitted would make `known_unsent` false and strand the payment
        // behind a signature that does not exist on chain: every retry of
        // POST /v1/payments would return the stale record without ever sending.
        let (state, _, request) = fixture();
        let mut record = initial(&request, SigningMode::Human).unwrap();
        record.signature = Some(signature(&request.signed_transaction).unwrap());
        record.status = PaymentStatus::Submitted;

        let classified = classify_send(&state, record, &RpcError::Busy)
            .await
            .unwrap();

        assert_eq!(classified.status, PaymentStatus::Prepared);
        assert!(
            known_unsent(&classified),
            "a retry must re-send the same bytes"
        );
        assert!(classified.signature.is_some(), "the audit trail survives");
    }

    #[tokio::test]
    async fn ambiguous_send_failures_still_stay_submitted() {
        // The opposite case, guarding the fix above from over-reaching: an error
        // raised after the request left us is ambiguous, and
        // docs/settlement-recovery.md forbids treating it as unsent.
        let (state, _, request) = fixture();
        let mut record = initial(&request, SigningMode::Human).unwrap();
        record.signature = Some(signature(&request.signed_transaction).unwrap());
        record.status = PaymentStatus::Submitted;

        let classified = classify_send(
            &state,
            record,
            &RpcError::Remote {
                method: "sendTransaction".to_owned(),
                message: "node is unhealthy".to_owned(),
                code: -32005,
            },
        )
        .await
        .unwrap();

        assert_eq!(classified.status, PaymentStatus::Submitted);
        assert!(
            !known_unsent(&classified),
            "never re-send on an ambiguous outcome"
        );
    }

    async fn claims(store: StatusStore) {
        let (mut state, principal, mut request) = fixture();
        state.store = store;
        request.amount = Some(u64::MAX);
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let state = state.clone();
            let principal = principal.clone();
            let request = request.clone();
            tasks.spawn(async move {
                reserve_payment(&state, &principal, &request, SigningMode::Human)
                    .await
                    .unwrap()
            });
        }
        let mut winners = 0;
        let mut id = None;
        while let Some(result) = tasks.join_next().await {
            let (won, record) = result.unwrap();
            winners += usize::from(won);
            assert_eq!(record.amount, Some(u64::MAX));
            if let Some(id) = &id {
                assert_eq!(id, &record.payment_id)
            }
            id = Some(record.payment_id);
        }
        assert_eq!(winners, 1);
        for field in [
            "amount",
            "mandate",
            "recipient",
            "invoice",
            "agent",
            "mint",
            "token",
            "mode",
            "message",
        ] {
            let mut changed = request.clone();
            let mut mode = SigningMode::Human;
            match field {
                "amount" => changed.amount = Some(1),
                "mandate" => changed.mandate = "changed".into(),
                "recipient" => changed.recipient = "changed".into(),
                "invoice" => changed.invoice_hash = "ab".repeat(32),
                "agent" => changed.agent = Some("changed".into()),
                "mint" => changed.mint = Some("changed".into()),
                "token" => changed.token_program = Some("changed".into()),
                "mode" => mode = SigningMode::Delegated,
                _ => {
                    changed.signed_transaction =
                        transactions::tests::fixture(0).1.signed_transaction
                }
            };
            assert!(
                matches!(
                    reserve_payment(&state, &principal, &changed, mode).await,
                    Err(ApiError::Conflict(_))
                ),
                "{field}"
            );
        }
        let (_, _, snapshot) = state
            .store
            .operation_record(&id.unwrap())
            .await
            .unwrap()
            .unwrap();
        let mut record: PaymentRecord = serde_json::from_value(snapshot.clone()).unwrap();
        record.status = PaymentStatus::Confirmed;
        state.store.put_payment(record.clone()).await.unwrap();
        let metadata = X402PaymentMetadata {
            resource: "https://fixture.invalid".into(),
            challenge: json!({"fixture":true}),
        };
        persist_payment(&state, &record, Some(&metadata))
            .await
            .unwrap();
        let mut proof = state
            .store
            .find_x402_by_idempotency(&record.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        proof.status = X402PaymentStatus::Verified;
        proof.proof = Some(json!({"verified":true}));
        proof.response_status = Some(200);
        state.store.put_x402(proof).await.unwrap();
        record.status = PaymentStatus::Submitted;
        record.updated_at_ms += 10;
        persist_payment(&state, &record, Some(&metadata))
            .await
            .unwrap();
        assert_eq!(
            state
                .store
                .get_payment(&record.payment_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            PaymentStatus::Confirmed
        );
        let proof = state
            .store
            .find_x402_by_idempotency(&record.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proof.status, X402PaymentStatus::Verified);
        assert_eq!(proof.proof, Some(json!({"verified":true})));
        assert_eq!(snapshot["amount"], "18446744073709551615");
        assert_eq!(
            serde_json::from_value::<PaymentRecord>(snapshot)
                .unwrap()
                .amount,
            Some(u64::MAX)
        );
    }
    #[tokio::test]
    async fn memory_claims_are_exclusive_and_all_intent_changes_conflict() {
        claims(StatusStore::in_memory()).await;
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_DATABASE_URL"]
    async fn postgres_operation_claims_survive_reconnect() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap();
        assert!(url.starts_with("postgresql://chainpay_test@127.0.0.1:55439/"));
        let store = StatusStore::connect(&url).await.unwrap();
        claims(store.clone()).await;
        let (mut state, principal, request) = fixture();
        state.store = store;
        let (_, record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        // Deliberately leave the materialized payment row absent, as after a crash.
        drop(state);
        let mut restored = BackendState::new(
            BackendConfig::from_env().unwrap(),
            StatusStore::connect(&url).await.unwrap(),
        )
        .unwrap();
        restored.config.rpc.url = "http://127.0.0.1:1".into();
        assert!(
            restored
                .store
                .get_payment(&record.payment_id)
                .await
                .unwrap()
                .is_none()
        );
        let (won, restored_record) =
            reserve_payment(&restored, &principal, &request, SigningMode::Human)
                .await
                .unwrap();
        assert!(!won);
        assert_eq!(restored_record.signature, record.signature);
        assert_eq!(
            restored
                .store
                .operation_owner(&record.payment_id)
                .await
                .unwrap(),
            Some(principal.wallet)
        );
    }
    fn receipt_data(record: &PaymentRecord) -> Vec<u8> {
        let mut data = vec![0; 282];
        data[..8].copy_from_slice(&[168, 198, 209, 4, 60, 235, 126, 109]);
        for (range, value) in [
            (8..40, &record.mandate),
            (104..136, record.mint.as_ref().unwrap()),
            (168..200, record.recipient.as_ref().unwrap()),
            (208..240, record.agent.as_ref().unwrap()),
        ] {
            data[range].copy_from_slice(&bs58::decode(value).into_vec().unwrap());
        }
        data[40..72].copy_from_slice(&decode_hex_32(&record.invoice_hash, "invoice").unwrap());
        data[200..208].copy_from_slice(&record.amount.unwrap().to_le_bytes());
        data[280] = 1;
        data
    }
    fn mandate_account_data(
        record: &PaymentRecord,
        paused: bool,
        revoked: bool,
        expires_at_slot: u64,
    ) -> Vec<u8> {
        let mut data = vec![0; 235];
        data[..8].copy_from_slice(&[139, 106, 43, 122, 82, 211, 96, 162]);
        data[40..72].copy_from_slice(
            &bs58::decode(record.agent.as_ref().unwrap())
                .into_vec()
                .unwrap(),
        );
        data[72..104].copy_from_slice(&[6; 32]);
        data[104..136].copy_from_slice(
            &bs58::decode(record.mint.as_ref().unwrap())
                .into_vec()
                .unwrap(),
        );
        data[200..208].copy_from_slice(&expires_at_slot.to_le_bytes());
        data[232] = u8::from(paused);
        data[233] = u8::from(revoked);
        data
    }
    fn rpc_account_info(
        address: &str,
        mandate: &str,
        mandate_data: &[u8],
        receipt_data: &[u8],
    ) -> Value {
        let encoded = if address == mandate {
            BASE64.encode(mandate_data)
        } else {
            BASE64.encode(receipt_data)
        };
        json!({"owner": DEFAULT_PROGRAM_ID, "data": [encoded, "base64"]})
    }
    #[tokio::test]
    async fn timeout_recovers_finalized_receipt_and_preserves_verified_proof() {
        let (mut state, principal, request) = fixture();
        let (_, record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        let stage = Arc::new(AtomicUsize::new(0));
        let sends = Arc::new(AtomicUsize::new(0));
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, false, false, u64::MAX);
        let fixture_record = record.clone();
        let stage_rpc = stage.clone();
        let sends_rpc = sends.clone();
        let signature = record.signature.clone().unwrap();
        let router=Router::new().fallback(move |Json(request):Json<Value>|{let stage=stage_rpc.load(Ordering::SeqCst);let sends=sends_rpc.clone();let receipt=receipt.clone();let mandate=mandate.clone();let fixture_record=fixture_record.clone();let signature=signature.clone();async move {
            let result=match request["method"].as_str().unwrap(){
                "sendTransaction"=>{sends.fetch_add(1,Ordering::SeqCst);return (StatusCode::BAD_GATEWAY,Json(json!({"error":"fixture transport ambiguity"})));},
                "getSignatureStatuses"=>{assert_eq!(request["params"][0][0],signature);json!({"value":[if stage==0{Value::Null}else{json!({"slot":7,"confirmationStatus":if stage==1{"confirmed"}else{"finalized"},"err":if stage==1||stage==4{json!({"InstructionError":[0,"fixture"]})}else{Value::Null}})}]})},
                "getAccountInfo"=>{
                    let address=request["params"][0].as_str().unwrap();
                    json!({"value":if stage==2 && address!=fixture_record.mandate{Value::Null}else{rpc_account_info(address,&fixture_record.mandate,&mandate,&receipt)}})
                },
                "getSlot"=>json!(1),
                other=>panic!("Unexpected RPC {other}"),
            };(StatusCode::OK,Json(json!({"jsonrpc":"2.0","id":1,"result":result})))
        }});
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let metadata = X402PaymentMetadata {
            resource: "https://merchant.example/resource".into(),
            challenge: json!({"amount":"10"}),
        };
        let mut request = request;
        request.x402 = Some(metadata.clone());
        // Claim snapshot alone can be read after a crash. Unsent reservations stay Prepared.
        let Json(gap) = get_payment(
            State(state.clone()),
            Extension(principal.clone()),
            Path(record.payment_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(gap.status, PaymentStatus::Prepared);
        assert!(known_unsent(&gap));
        let wrong = Principal {
            wallet: bs58::encode([99; 32]).into_string(),
            scope: None,
        };
        assert!(
            get_payment(
                State(state.clone()),
                Extension(wrong),
                Path(record.payment_id.clone())
            )
            .await
            .is_err()
        );
        let Json(pending) = settle_payment(&state, request, record.clone())
            .await
            .unwrap();
        assert_eq!(pending.status, PaymentStatus::Submitted);
        assert_eq!(pending.signature, record.signature);
        let sent = sends.load(Ordering::SeqCst);
        assert!(sent > 0);
        stage.store(1, Ordering::SeqCst);
        let pending = payment(&state, pending).await.unwrap();
        assert_eq!(pending.status, PaymentStatus::Submitted);
        stage.store(2, Ordering::SeqCst);
        let pending = payment(&state, pending).await.unwrap();
        assert_eq!(pending.status, PaymentStatus::Submitted);
        assert!(
            pending
                .error
                .as_ref()
                .unwrap()
                .contains("receipt verification pending")
        );
        stage.store(3, Ordering::SeqCst);
        let confirmed = payment(&state, pending).await.unwrap();
        assert_eq!(confirmed.status, PaymentStatus::Confirmed);
        assert_eq!(confirmed.slot, Some(7));
        let mut proof = state
            .store
            .find_x402_by_idempotency(&record.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        proof.status = X402PaymentStatus::Verified;
        proof.proof = Some(json!({"verified":true}));
        proof.response_status = Some(200);
        proof.updated_at_ms = now_ms();
        state.store.put_x402(proof).await.unwrap();
        let mut stale = record.clone();
        stale.status = PaymentStatus::Submitted;
        stale.updated_at_ms = now_ms() + 100;
        persist_payment(&state, &stale, Some(&metadata))
            .await
            .unwrap();
        assert_eq!(
            state
                .store
                .get_payment(&record.payment_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            PaymentStatus::Confirmed
        );
        let proof = state
            .store
            .find_x402_by_idempotency(&record.idempotency_key)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proof.status, X402PaymentStatus::Verified);
        assert_eq!(proof.proof, Some(json!({"verified":true})));
        stage.store(4, Ordering::SeqCst);
        let mut rejected = record;
        rejected.payment_id.push_str("-failed");
        rejected.idempotency_key.push_str("-failed");
        assert_eq!(
            payment(&state, rejected).await.unwrap().status,
            PaymentStatus::Failed
        );
        assert_eq!(sends.load(Ordering::SeqCst), sent);
        task.abort();
    }
    #[tokio::test]
    async fn provisioning_uncertainty_reserves_one_provider_identity() {
        use ed25519_dalek::Signer;
        let (_, request, signer) = transactions::tests::fixture(0);
        let owner = request.agent.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let router = Router::new()
            .route(
                "/v1/wallets",
                post(move |Json(body): Json<Value>| {
                    let calls = observed.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert!(
                            body["external_id"]
                                .as_str()
                                .unwrap()
                                .starts_with("chainpay_")
                        );
                        (StatusCode::BAD_GATEWAY, "fixture uncertainty")
                    }
                }),
            )
            .fallback(|| async { Json(json!({"jsonrpc":"2.0","id":1,"result":{"value":null}})) });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut config = BackendConfig::from_env().unwrap();
        config.rpc.url = format!("http://{address}");
        let mut state = BackendState::new(config, StatusStore::in_memory()).unwrap();
        state.signer_provider = Some(PrivySignerProvider::fixture(format!("http://{address}")));
        let principal = Principal {
            wallet: owner.clone(),
            scope: None,
        };
        for index in 0..2 {
            let id = format!("fixture-challenge-{index}");
            let message = format!("owner mandate authorization {index}");
            state
                .store
                .put_managed_signer_challenge(ManagedSignerChallenge {
                    challenge_id: id.clone(),
                    owner_wallet: owner.clone(),
                    mandate_pda: request.mandate.clone(),
                    message: message.clone(),
                    expires_at_ms: now_ms() + 60_000,
                    consumed_at_ms: None,
                    created_at_ms: now_ms(),
                })
                .await
                .unwrap();
            let signature = BASE64.encode(signer.sign(message.as_bytes()).to_bytes());
            for _ in 0..2 {
                assert!(matches!(
                    provision_managed_signer(
                        State(state.clone()),
                        Extension(principal.clone()),
                        Json(ManagedSignerProvisionRequest {
                            challenge_id: id.clone(),
                            signature: signature.clone()
                        })
                    )
                    .await,
                    Err(ApiError::Conflict(_))
                ));
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let id = deterministic_id("provision", &format!("{}:{}", owner, request.mandate));
        let (stored_owner, _, snapshot) = state.store.operation_record(&id).await.unwrap().unwrap();
        assert_eq!(stored_owner, owner);
        assert_eq!(
            snapshot["provider_request_reference"],
            crate::signer::external_id(&owner, &request.mandate)
        );
        task.abort();
    }

    #[tokio::test]
    async fn legacy_keys_never_establish_ownership_or_allow_execution() {
        let (state, principal, request) = fixture();
        let record = initial(&request, SigningMode::Human).unwrap();
        state.store.put_payment(record.clone()).await.unwrap();
        assert_eq!(
            state
                .store
                .operation_owner(&record.payment_id)
                .await
                .unwrap(),
            None
        );
        assert!(matches!(
            existing_payment(&state, &principal, &request, SigningMode::Human).await,
            Err(ApiError::Conflict(_))
        ));
        let migration = include_str!("../migrations/0007_operation_claims.sql");
        assert!(!migration.contains("split_part"));
        assert!(!migration.contains("INSERT INTO operation_claims"));
    }
    #[tokio::test]
    async fn cancellation_and_reservation_are_atomic_and_cancellation_blocks_late_worker() {
        let (state, principal, request) = fixture();
        let key = request
            .idempotency_key
            .strip_prefix(&format!("{}:", principal.wallet))
            .unwrap()
            .to_owned();
        let Json(cancelled) = cancel_unstarted(
            State(state.clone()),
            Extension(principal.clone()),
            Json(CancelUnstarted {
                kind: "payments".into(),
                key,
            }),
        )
        .await
        .unwrap();
        assert_eq!(cancelled["cancelled"], true);
        assert!(matches!(
            reserve_payment(&state, &principal, &request, SigningMode::Human).await,
            Err(ApiError::Conflict(_))
        ));
        let (state, principal, request) = fixture();
        let key = request
            .idempotency_key
            .strip_prefix(&format!("{}:", principal.wallet))
            .unwrap()
            .to_owned();
        reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        assert!(matches!(
            cancel_unstarted(
                State(state),
                Extension(principal),
                Json(CancelUnstarted {
                    kind: "payments".into(),
                    key
                })
            )
            .await,
            Err(ApiError::Conflict(_))
        ));
    }
    #[tokio::test]
    async fn recovery_rejects_changed_signature_message_before_network() {
        let (state, principal, request) = fixture();
        let (_, record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        let other = transactions::tests::fixture(0).1;
        assert!(
            recover_payment(
                State(state.clone()),
                Extension(principal),
                Path(record.payment_id),
                Json(RecoverSigned {
                    signed_transaction: other.signed_transaction,
                    resubmit: true
                })
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn already_processed_send_reconciles_original_signature() {
        let (mut state, principal, request) = fixture();
        let (_, record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, false, false, u64::MAX);
        let fixture_record = record.clone();
        let signature = record.signature.clone().unwrap();
        let router = Router::new().fallback(move |Json(body): Json<Value>| {
            let receipt = receipt.clone();
            let mandate = mandate.clone();
            let fixture_record = fixture_record.clone();
            async move {
                if body["method"] == "sendTransaction" {
                    return (
                        StatusCode::OK,
                        Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Transaction simulation failed: AlreadyProcessed"}})),
                    );
                }
                let result = match body["method"].as_str().unwrap() {
                    "getSignatureStatuses" => {
                        json!({"value":[{"slot":9,"confirmationStatus":"finalized","err":Value::Null}]})
                    }
                    "getAccountInfo" => {
                        let address = body["params"][0].as_str().unwrap();
                        json!({"value": rpc_account_info(
                            address,
                            &fixture_record.mandate,
                            &mandate,
                            &receipt,
                        )})
                    }
                    "getSlot" => json!(1),
                    other => panic!("Unexpected RPC {other}"),
                };
                (StatusCode::OK, Json(json!({"jsonrpc":"2.0","id":1,"result":result})))
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let Json(settled) = settle_payment(&state, request, record.clone())
            .await
            .unwrap();
        assert_eq!(settled.status, PaymentStatus::Confirmed);
        assert_eq!(settled.signature.as_ref(), record.signature.as_ref());
        assert_eq!(settled.signature.as_deref(), Some(signature.as_str()));
        task.abort();
    }

    #[tokio::test]
    async fn reserved_unsent_retry_broadcasts_original_bytes_once() {
        let (mut state, principal, request) = fixture();
        let (won, record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        assert!(won);
        assert!(known_unsent(&record));
        let sends = Arc::new(AtomicUsize::new(0));
        let landed = Arc::new(AtomicUsize::new(0));
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, false, false, u64::MAX);
        let fixture_record = record.clone();
        let signature = record.signature.clone().unwrap();
        let sends_rpc = sends.clone();
        let landed_rpc = landed.clone();
        let router = Router::new().fallback(move |Json(body): Json<Value>| {
            let receipt = receipt.clone();
            let mandate = mandate.clone();
            let fixture_record = fixture_record.clone();
            let signature = signature.clone();
            let sends = sends_rpc.clone();
            let landed = landed_rpc.clone();
            async move {
                let result = match body["method"].as_str().unwrap() {
                    "sendTransaction" => {
                        sends.fetch_add(1, Ordering::SeqCst);
                        landed.store(1, Ordering::SeqCst);
                        json!(signature)
                    }
                    "getSignatureStatuses" => {
                        if landed.load(Ordering::SeqCst) == 0 {
                            json!({"value":[Value::Null]})
                        } else {
                            json!({"value":[{"slot":3,"confirmationStatus":"finalized","err":Value::Null}]})
                        }
                    }
                    "getAccountInfo" => {
                        let address = body["params"][0].as_str().unwrap();
                        json!({"value": rpc_account_info(
                            address,
                            &fixture_record.mandate,
                            &mandate,
                            &receipt,
                        )})
                    }
                    "getSlot" => json!(1),
                    other => panic!("Unexpected RPC {other}"),
                };
                (StatusCode::OK, Json(json!({"jsonrpc":"2.0","id":1,"result":result})))
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let existing = existing_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap()
            .unwrap();
        assert!(known_unsent(&existing));
        let Json(settled) = settle_payment(&state, request.clone(), existing)
            .await
            .unwrap();
        assert_eq!(settled.status, PaymentStatus::Confirmed);
        let again = existing_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap()
            .unwrap();
        assert!(!known_unsent(&again));
        assert_eq!(again.status, PaymentStatus::Confirmed);
        assert_eq!(sends.load(Ordering::SeqCst), 1);
        task.abort();
    }

    #[tokio::test]
    async fn paused_mandate_blocks_immediate_pre_send_validation() {
        let (mut state, _, request) = fixture();
        let mut record = initial(&request, SigningMode::Human).unwrap();
        record.signature = Some(signature(&request.signed_transaction).unwrap());
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, true, false, u64::MAX);
        let fixture_record = record.clone();
        let router = Router::new().fallback(move |Json(body): Json<Value>| {
            let receipt = receipt.clone();
            let mandate = mandate.clone();
            let fixture_record = fixture_record.clone();
            async move {
                let result = match body["method"].as_str().unwrap() {
                    "getAccountInfo" => {
                        let address = body["params"][0].as_str().unwrap();
                        json!({"value": rpc_account_info(
                            address,
                            &fixture_record.mandate,
                            &mandate,
                            &receipt,
                        )})
                    }
                    "getSlot" => json!(1),
                    other => panic!("Unexpected RPC {other}"),
                };
                (
                    StatusCode::OK,
                    Json(json!({"jsonrpc":"2.0","id":1,"result":result})),
                )
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let result = settle_payment(&state, request, record.clone()).await;
        assert!(matches!(result, Err(ApiError::BadRequest(_))));
        assert_eq!(record.status, PaymentStatus::Prepared);
        task.abort();
    }

    #[tokio::test]
    async fn revoked_mandate_does_not_block_submitted_reconciliation() {
        let (mut state, _, request) = fixture();
        let mut record = initial(&request, SigningMode::Human).unwrap();
        record.signature = Some(signature(&request.signed_transaction).unwrap());
        record.status = PaymentStatus::Submitted;
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, false, true, u64::MAX);
        let fixture_record = record.clone();
        let router = Router::new().fallback(move |Json(body): Json<Value>| {
            let receipt = receipt.clone();
            let mandate = mandate.clone();
            let fixture_record = fixture_record.clone();
            async move {
                let result = match body["method"].as_str().unwrap() {
                    "getSignatureStatuses" => {
                        json!({"value":[{"slot":9,"confirmationStatus":"finalized","err":Value::Null}]})
                    }
                    "getAccountInfo" => {
                        let address = body["params"][0].as_str().unwrap();
                        json!({"value": rpc_account_info(
                            address,
                            &fixture_record.mandate,
                            &mandate,
                            &receipt,
                        )})
                    }
                    other => panic!("Unexpected RPC {other}"),
                };
                (StatusCode::OK, Json(json!({"jsonrpc":"2.0","id":1,"result":result})))
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let reconciled = payment(&state, record).await.unwrap();
        assert_eq!(reconciled.status, PaymentStatus::Confirmed);
        task.abort();
    }

    #[tokio::test]
    async fn recovery_resubmit_honors_revoked_mandate_without_failing_prior_submission() {
        let (mut state, principal, request) = fixture();
        let (_, mut record) = reserve_payment(&state, &principal, &request, SigningMode::Human)
            .await
            .unwrap();
        record.status = PaymentStatus::Submitted;
        record.signature = Some(signature(&request.signed_transaction).unwrap());
        state.store.put_payment(record.clone()).await.unwrap();
        let receipt = receipt_data(&record);
        let mandate = mandate_account_data(&record, false, true, u64::MAX);
        let fixture_record = record.clone();
        let sends = Arc::new(AtomicUsize::new(0));
        let sends_rpc = sends.clone();
        let router = Router::new().fallback(move |Json(body): Json<Value>| {
            let receipt = receipt.clone();
            let mandate = mandate.clone();
            let fixture_record = fixture_record.clone();
            let sends = sends_rpc.clone();
            async move {
                let result = match body["method"].as_str().unwrap() {
                    "sendTransaction" => {
                        sends.fetch_add(1, Ordering::SeqCst);
                        json!("should-not-send")
                    }
                    "getSignatureStatuses" => json!({"value":[Value::Null]}),
                    "isBlockhashValid" => json!(true),
                    "getAccountInfo" => {
                        let address = body["params"][0].as_str().unwrap();
                        json!({"value": rpc_account_info(
                            address,
                            &fixture_record.mandate,
                            &mandate,
                            &receipt,
                        )})
                    }
                    "getSlot" => json!(1),
                    other => panic!("Unexpected RPC {other}"),
                };
                (
                    StatusCode::OK,
                    Json(json!({"jsonrpc":"2.0","id":1,"result":result})),
                )
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        assert!(
            recover_payment(
                State(state.clone()),
                Extension(principal.clone()),
                Path(record.payment_id.clone()),
                Json(RecoverSigned {
                    signed_transaction: request.signed_transaction.clone(),
                    resubmit: true
                })
            )
            .await
            .is_err()
        );
        assert_eq!(sends.load(Ordering::SeqCst), 0);
        let stored = state
            .store
            .get_payment(&record.payment_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, PaymentStatus::Submitted);
        task.abort();
    }

    #[test]
    fn deterministic_rejection_differs_from_timeout() {
        let (_, _, request) = fixture();
        let record = initial(&request, SigningMode::Human).unwrap();
        assert_eq!(
            payment_error(
                record.clone(),
                &RpcError::ConfirmationTimeout {
                    signature: "fixture".into()
                }
            )
            .status,
            PaymentStatus::Submitted
        );
        assert_eq!(
            payment_error(
                record.clone(),
                &RpcError::Remote {
                    method: "sendTransaction".into(),
                    code: -32002,
                    message: "Transaction simulation failed: AlreadyProcessed".into()
                }
            )
            .status,
            PaymentStatus::Submitted
        );
        assert_eq!(
            payment_error(
                record,
                &RpcError::Remote {
                    method: "sendTransaction".into(),
                    code: -32002,
                    message: "sensitive fixture should not propagate".into()
                }
            )
            .status,
            PaymentStatus::Failed
        );
    }
}
