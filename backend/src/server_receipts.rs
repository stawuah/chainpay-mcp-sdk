//! Receipt context: the merchant-signed request behind a receipt and the
//! policy limits beside it. The receipt account on Solana stays the payment
//! evidence; nothing here changes whether a payment counts as paid.

use super::*;
use crate::api::PaymentRequestPayload;
use crate::receipts::{
    ObservedPolicyRecord, RECEIPT_ACCOUNT_LENGTH, ReceiptPolicyView, ReceiptRequestRecord,
    canonical_payment_request, check_payment_request_fields, mandate_policy_fields,
    parse_receipt_policy_snapshot, verify_payment_request_signature,
};

const RECEIPT_DISCRIMINATOR: [u8; 8] = [168, 198, 209, 4, 60, 235, 126, 109];
const RECEIPT_STATUS_SETTLED: u8 = 1;

pub(super) const DUPLICATE_INVOICE_MESSAGE: &str =
    "This invoice was already paid. Nothing new was submitted.";

/// Check an attached merchant request against the payment it settles and
/// return the row to keep. The request must be signed by its merchant, hash to
/// the payment's invoice hash, and name the same mint, recipient and amount.
/// Expiry is not checked: this is evidence of what was asked for, and the
/// payment itself is bounded by the mandate on chain.
pub(super) fn receipt_request_record(
    config: &BackendConfig,
    request: &PaymentSubmissionRequest,
) -> Result<Option<ReceiptRequestRecord>, ApiError> {
    let Some(signed) = &request.payment_request else {
        return Ok(None);
    };
    let invalid = |reason: String| ApiError::BadRequest(format!("payment_request {reason}"));
    check_payment_request_fields(&signed.payload, config.cluster).map_err(invalid)?;
    let (canonical, hash) = canonical_payment_request(&signed.payload).map_err(invalid)?;
    verify_payment_request_signature(signed, &canonical).map_err(invalid)?;
    let invoice_hash = request
        .invoice_hash
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase();
    if hex_encode(&hash) != invoice_hash {
        return Err(invalid(
            "does not hash to this payment's invoice_hash".to_owned(),
        ));
    }
    let payload = &signed.payload;
    if payload.recipient != request.recipient
        || request
            .mint
            .as_deref()
            .is_some_and(|mint| mint != payload.mint)
        || request
            .amount
            .is_some_and(|amount| amount.to_string() != payload.amount)
    {
        return Err(invalid(
            "names a different mint, recipient, or amount than this payment".to_owned(),
        ));
    }
    let receipt_address = request.receipt_address.clone().ok_or_else(|| {
        ApiError::BadRequest("receipt_address is required for settlement verification".into())
    })?;
    Ok(Some(ReceiptRequestRecord {
        cluster: config.cluster.to_owned(),
        program_id: config.program_id.clone(),
        receipt_address,
        mandate: request.mandate.clone(),
        invoice_hash,
        merchant: payload.merchant.clone(),
        canonical_payload: String::from_utf8(canonical)
            .map_err(|_| invalid("is not valid UTF-8".to_owned()))?,
        signature: signed.signature.clone(),
        stored_at_ms: now_ms(),
    }))
}

/// Keep the merchant request for this payment's receipt. Called on the
/// settlement path just before broadcast, so a payment that is never sent
/// leaves at most an unreadable row: the read endpoint serves a request only
/// once its receipt is settled on chain.
pub(super) async fn keep_receipt_request(
    state: &BackendState,
    request: &PaymentSubmissionRequest,
) -> Result<(), ApiError> {
    if let Some(record) = receipt_request_record(&state.config, request)? {
        state.store.put_receipt_request(record).await?;
    }
    Ok(())
}

/// For a receipt with no on-chain snapshot, read its mandate once from a node
/// at or past the payment slot and keep what it shows. Best effort: a failed
/// observation leaves the receipt "not recorded" and never affects settlement.
pub(super) async fn observe_policy(state: &BackendState, receipt_address: &str, receipt: &[u8]) {
    if let Err(error) = try_observe_policy(state, receipt_address, receipt).await {
        eprintln!("[chainpay] policy observation skipped for {receipt_address}: {error}");
    }
}

async fn try_observe_policy(
    state: &BackendState,
    receipt_address: &str,
    receipt: &[u8],
) -> Result<(), String> {
    if receipt.len() < RECEIPT_ACCOUNT_LENGTH || parse_receipt_policy_snapshot(receipt).is_some() {
        return Ok(());
    }
    let cluster = state.config.cluster;
    let program_id = &state.config.program_id;
    if state
        .store
        .find_observed_policy(cluster, program_id, receipt_address)
        .await
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    let mandate = bs58::encode(&receipt[8..40]).into_string();
    let executed_at_slot = u64::from_le_bytes(receipt[240..248].try_into().unwrap());
    let (account, observed_at_slot) = state
        .rpc
        .account_info_since(&mandate, executed_at_slot)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "mandate account is gone".to_owned())?;
    if account.owner != *program_id {
        return Err("mandate is not owned by the ChainPay program".into());
    }
    let (limits, last_payment_slot) =
        mandate_policy_fields(&account.data).ok_or_else(|| "mandate data is invalid".to_owned())?;
    state
        .store
        .put_observed_policy(ObservedPolicyRecord {
            cluster: cluster.to_owned(),
            program_id: program_id.clone(),
            receipt_address: receipt_address.to_owned(),
            mandate,
            limits,
            observed_at_slot,
            includes_later_payments: last_payment_slot != executed_at_slot,
            observed_at_ms: now_ms(),
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Settled ChainPay receipt at `address`: program-owned, receipt-typed, at
/// least the original length, and settled.
fn settled_receipt(account: &RpcAccount, program_id: &str) -> Option<()> {
    (account.owner == program_id
        && account.data.len() >= RECEIPT_ACCOUNT_LENGTH
        && account.data[..8] == RECEIPT_DISCRIMINATOR
        && account.data[280] == RECEIPT_STATUS_SETTLED)
        .then_some(())
}

/// The limits to show beside a receipt, labeled by source. Callers pass the
/// receipt account only after a successful read: an RPC failure is reported
/// as no policy at all, never as "not recorded".
pub(super) async fn policy_view(
    state: &BackendState,
    receipt_address: &str,
    receipt: Option<&RpcAccount>,
) -> Result<ReceiptPolicyView, ApiError> {
    let observed = state
        .store
        .find_observed_policy(
            state.config.cluster,
            &state.config.program_id,
            receipt_address,
        )
        .await?;
    Ok(ReceiptPolicyView::from_sources(
        receipt.map(|account| account.data.as_slice()),
        observed.as_ref(),
    ))
}

/// `GET /v1/receipts/{receipt_address}`: the relay's payment record for a
/// receipt, plus the policy limits beside it. A receipt the relay never
/// relayed (for example one the owner's wallet sent directly) still returns
/// its limits once the caller is authorized for its mandate.
pub(super) async fn get_receipt(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(receipt_address): Path<String>,
) -> Result<Json<Value>, ApiError> {
    validate_solana_address(&receipt_address, "receipt_address")?;
    let record = state
        .store
        .find_payment_by_receipt(&receipt_address)
        .await?;
    if let Some(record) = &record {
        recovery::authorize_payment(&state, &principal, record, "get_payment").await?;
    }
    let account = state.rpc.account_info(&receipt_address).await;
    let mut body = match record {
        Some(record) => {
            let record = recovery::payment(&state, record).await?;
            serde_json::to_value(record).map_err(|_| ApiError::NotFound)?
        }
        None => {
            let account = account
                .as_ref()
                .ok()
                .and_then(Option::as_ref)
                .filter(|account| settled_receipt(account, &state.config.program_id).is_some())
                .ok_or(ApiError::NotFound)?;
            let mandate = bs58::encode(&account.data[8..40]).into_string();
            auth::mandate(&state, &principal, &mandate, "get_payment").await?;
            json!({ "receipt_address": receipt_address, "mandate": mandate })
        }
    };
    body["policy"] = match &account {
        Ok(account) => {
            serde_json::to_value(policy_view(&state, &receipt_address, account.as_ref()).await?)
                .unwrap_or(Value::Null)
        }
        Err(_) => Value::Null,
    };
    Ok(Json(body))
}

/// `GET /v1/receipts/{receipt_address}/request`: the merchant-signed request
/// behind a settled receipt. Owner wallet session only: a scoped agent
/// connection, a shared service token, or anyone else gets nothing, because
/// the request can carry order details the owner has not chosen to share.
pub(super) async fn get_receipt_request(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(receipt_address): Path<String>,
) -> Result<Json<Value>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    validate_solana_address(&receipt_address, "receipt_address")?;
    let record = state
        .store
        .find_receipt_request(
            state.config.cluster,
            &state.config.program_id,
            &receipt_address,
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    auth::mandate(&state, &principal, &record.mandate, "get_payment").await?;
    let account = state
        .rpc
        .account_info(&receipt_address)
        .await?
        .ok_or(ApiError::NotFound)?;
    settled_receipt(&account, &state.config.program_id).ok_or(ApiError::NotFound)?;
    if hex_encode(&account.data[40..72]) != record.invoice_hash
        || bs58::encode(&account.data[8..40]).into_string() != record.mandate
    {
        return Err(ApiError::NotFound);
    }
    let payload: PaymentRequestPayload =
        serde_json::from_str(&record.canonical_payload).map_err(|_| ApiError::NotFound)?;
    Ok(Json(json!({
        "receipt_address": record.receipt_address,
        "invoice_hash": record.invoice_hash,
        "request": { "payload": payload, "signature": record.signature },
        "stored_at_ms": record.stored_at_ms,
    })))
}

/// Simulation refused the payment because its receipt account already exists:
/// the invoice was paid before. Matches only when the error names this
/// payment's receipt, so an unrelated "already in use" stays as reported.
pub(super) fn is_duplicate_receipt_error(message: &str, receipt_address: Option<&str>) -> bool {
    receipt_address
        .is_some_and(|receipt| message.contains("already in use") && message.contains(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{PaymentRequestLineItem, PaymentRequestPayload};
    use crate::receipts::{RECEIPT_ACCOUNT_LENGTH_V2, ReceiptPolicyLimits};
    use ed25519_dalek::{Signer as _, SigningKey};
    use solana_address::Address;
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};

    const SETTLED_SIGNATURE: &str = "fixture-signature";

    /// Minimal Solana RPC: accounts by address, every getAccountInfo request
    /// recorded so a test can see minContextSlot, and a fixed context slot.
    #[derive(Clone, Default)]
    struct Chain {
        accounts: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        requests: Arc<Mutex<Vec<Value>>>,
        context_slot: u64,
        own_signature_landed: bool,
    }

    impl Chain {
        fn put(&self, address: &str, data: Vec<u8>) {
            self.accounts
                .lock()
                .unwrap()
                .insert(address.to_owned(), data);
        }

        async fn serve(self, state: &mut BackendState) -> tokio::task::JoinHandle<()> {
            let chain = self.clone();
            let router = Router::new().fallback(move |Json(body): Json<Value>| {
                let chain = chain.clone();
                async move {
                    let result = match body["method"].as_str().unwrap_or_default() {
                        "getAccountInfo" => {
                            chain.requests.lock().unwrap().push(body["params"].clone());
                            let address = body["params"][0].as_str().unwrap_or_default();
                            let value = chain.accounts.lock().unwrap().get(address).map(|data| {
                                json!({"owner": DEFAULT_PROGRAM_ID, "data": [BASE64.encode(data), "base64"]})
                            });
                            json!({"context": {"slot": chain.context_slot}, "value": value})
                        }
                        "getSignatureStatuses" => {
                            if chain.own_signature_landed {
                                json!({"value":[{"slot":3,"confirmationStatus":"finalized","err":Value::Null}]})
                            } else {
                                json!({"value":[Value::Null]})
                            }
                        }
                        "getSlot" => json!(1),
                        "getProgramAccounts" => json!([]),
                        other => panic!("Unexpected RPC {other}"),
                    };
                    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
                }
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            state.config.rpc.url = format!("http://{address}");
            state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
            tokio::spawn(async move { axum::serve(listener, router).await.unwrap() })
        }
    }

    fn state() -> BackendState {
        BackendState::new(BackendConfig::from_env().unwrap(), StatusStore::in_memory()).unwrap()
    }

    fn key(byte: u8) -> String {
        bs58::encode([byte; 32]).into_string()
    }

    fn merchant() -> SigningKey {
        SigningKey::from_bytes(&[42_u8; 32])
    }

    fn signed_request(description: &str) -> SignedPaymentRequest {
        let merchant = merchant();
        let payload = PaymentRequestPayload {
            version: 1,
            cluster: "devnet".into(),
            merchant: bs58::encode(merchant.verifying_key().as_bytes()).into_string(),
            invoice: "PO-1042".into(),
            mint: key(5),
            token_program: "spl-token".into(),
            recipient: key(7),
            amount: "4500000".into(),
            decimals: 6,
            nonce: "nonce-1".into(),
            expires_at_slot: Some("1".into()),
            resource: None,
            description: Some(description.into()),
            line_items: Some(vec![PaymentRequestLineItem {
                label: "Widget".into(),
                amount: Some("4500000".into()),
                quantity: Some("1".into()),
            }]),
        };
        let (canonical, _) = canonical_payment_request(&payload).unwrap();
        SignedPaymentRequest {
            payload,
            signature: BASE64.encode(merchant.sign(&canonical).to_bytes()),
        }
    }

    fn invoice_hash(request: &SignedPaymentRequest) -> [u8; 32] {
        canonical_payment_request(&request.payload).unwrap().1
    }

    fn receipt_address(mandate: &str, invoice: &[u8; 32]) -> String {
        Address::find_program_address(
            &[
                b"receipt",
                &bs58::decode(mandate).into_vec().unwrap(),
                invoice,
            ],
            &Address::from_str(DEFAULT_PROGRAM_ID).unwrap(),
        )
        .0
        .to_string()
    }

    fn submission(request: SignedPaymentRequest) -> PaymentSubmissionRequest {
        let invoice = invoice_hash(&request);
        PaymentSubmissionRequest {
            idempotency_key: "owner:1".into(),
            mandate: key(2),
            invoice_hash: hex_encode(&invoice),
            receipt_address: Some(receipt_address(&key(2), &invoice)),
            signed_transaction: String::new(),
            agent: Some(key(4)),
            mint: Some(key(5)),
            recipient: key(7),
            amount: Some(4_500_000),
            token_program: Some("spl-token".into()),
            x402: None,
            payment_request: Some(request),
        }
    }

    /// A settled receipt for `submission`, 282 bytes, executed at slot 40.
    fn receipt_for(payment: &PaymentSubmissionRequest) -> Vec<u8> {
        let mut data = vec![0_u8; RECEIPT_ACCOUNT_LENGTH];
        data[..8].copy_from_slice(&RECEIPT_DISCRIMINATOR);
        data[8..40].copy_from_slice(&bs58::decode(&payment.mandate).into_vec().unwrap());
        data[40..72].copy_from_slice(
            &crate::server::decode_hex_32(&payment.invoice_hash, "invoice").unwrap(),
        );
        data[104..136].copy_from_slice(&[5; 32]);
        data[168..200].copy_from_slice(&[7; 32]);
        data[200..208].copy_from_slice(&payment.amount.unwrap().to_le_bytes());
        data[208..240].copy_from_slice(&[4; 32]);
        data[240..248].copy_from_slice(&40_u64.to_le_bytes());
        data[280] = RECEIPT_STATUS_SETTLED;
        data
    }

    fn with_snapshot(mut data: Vec<u8>) -> Vec<u8> {
        data.resize(RECEIPT_ACCOUNT_LENGTH_V2, 0);
        data[282] = 1;
        for (index, value) in [5_000_000_u64, 50_000_000, 4_500_000, 1, 0, 9_000, 0]
            .iter()
            .enumerate()
        {
            let offset = 283 + index * 8;
            data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        data
    }

    fn mandate_for(owner: &str, last_payment_slot: u64) -> Vec<u8> {
        let mut data = vec![0_u8; 235];
        data[..8].copy_from_slice(&[139, 106, 43, 122, 82, 211, 96, 162]);
        data[8..40].copy_from_slice(&bs58::decode(owner).into_vec().unwrap());
        data[40..72].copy_from_slice(&[4; 32]);
        data[72..104].copy_from_slice(&[6; 32]);
        data[104..136].copy_from_slice(&[5; 32]);
        for (offset, value) in [
            (168, 5_000_000_u64),
            (176, 50_000_000),
            (184, 4_500_000),
            (192, 1),
            (200, u64::MAX),
            (208, 10),
            (216, 0),
            (224, last_payment_slot),
        ] {
            data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        data
    }

    fn record_for(payment: &PaymentSubmissionRequest) -> PaymentRecord {
        PaymentRecord {
            payment_id: "payment-1".into(),
            idempotency_key: payment.idempotency_key.clone(),
            mandate: payment.mandate.clone(),
            invoice_hash: payment.invoice_hash.clone(),
            receipt_address: payment.receipt_address.clone(),
            agent: payment.agent.clone(),
            mint: payment.mint.clone(),
            recipient: Some(payment.recipient.clone()),
            amount: payment.amount,
            token_program: payment.token_program.clone(),
            signing_mode: SigningMode::Human,
            signature: Some(SETTLED_SIGNATURE.into()),
            slot: None,
            status: PaymentStatus::Submitted,
            error: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn attached_request_must_be_signed_hash_to_the_invoice_and_match_the_payment() {
        let config = BackendConfig::from_env().unwrap();
        let payment = submission(signed_request("Two widgets"));
        let record = receipt_request_record(&config, &payment).unwrap().unwrap();
        assert_eq!(record.invoice_hash, payment.invoice_hash);
        assert_eq!(
            record.receipt_address,
            payment.receipt_address.clone().unwrap()
        );
        assert!(
            record
                .canonical_payload
                .contains("\"description\":\"Two widgets\"")
        );

        // Expired requests are still the request that was paid.
        assert_eq!(
            payment
                .payment_request
                .as_ref()
                .unwrap()
                .payload
                .expires_at_slot
                .as_deref(),
            Some("1")
        );

        let mut wrong_hash = payment.clone();
        wrong_hash.invoice_hash = "00".repeat(32);
        assert!(matches!(
            receipt_request_record(&config, &wrong_hash),
            Err(ApiError::BadRequest(message)) if message.contains("invoice_hash")
        ));

        let mut tampered = payment.clone();
        tampered
            .payment_request
            .as_mut()
            .unwrap()
            .payload
            .description = Some("Three widgets".into());
        tampered.invoice_hash =
            hex_encode(&invoice_hash(tampered.payment_request.as_ref().unwrap()));
        assert!(matches!(
            receipt_request_record(&config, &tampered),
            Err(ApiError::BadRequest(message)) if message.contains("signature is invalid")
        ));

        let mut other_amount = payment.clone();
        other_amount.amount = Some(1);
        assert!(matches!(
            receipt_request_record(&config, &other_amount),
            Err(ApiError::BadRequest(message)) if message.contains("different mint, recipient, or amount")
        ));

        let mut none = payment;
        none.payment_request = None;
        assert!(receipt_request_record(&config, &none).unwrap().is_none());
    }

    #[tokio::test]
    async fn request_endpoint_is_owner_session_only_and_waits_for_settlement() {
        let mut state = state();
        let owner = key(11);
        let payment = submission(signed_request("Two widgets"));
        let receipt = payment.receipt_address.clone().unwrap();
        let chain = Chain::default();
        chain.put(&payment.mandate, mandate_for(&owner, 40));
        let task = chain.clone().serve(&mut state).await;
        keep_receipt_request(&state, &payment).await.unwrap();

        let call = |principal: Principal| {
            get_receipt_request(
                State(state.clone()),
                Extension(principal),
                Path(receipt.clone()),
            )
        };
        let owner_session = Principal {
            wallet: owner.clone(),
            scope: None,
        };

        // Kept at settlement, served only once the receipt is settled on chain.
        assert!(matches!(
            call(owner_session.clone()).await,
            Err(ApiError::NotFound)
        ));
        chain.put(&receipt, receipt_for(&payment));

        let Json(body) = call(owner_session.clone()).await.unwrap();
        assert_eq!(body["invoice_hash"], payment.invoice_hash);
        let returned: SignedPaymentRequest =
            serde_json::from_value(body["request"].clone()).unwrap();
        let (canonical, hash) = canonical_payment_request(&returned.payload).unwrap();
        assert_eq!(hex_encode(&hash), payment.invoice_hash);
        verify_payment_request_signature(&returned, &canonical).unwrap();

        // Another wallet, and the owner's own scoped agent connection, get nothing.
        assert!(matches!(
            call(Principal {
                wallet: key(12),
                scope: None
            })
            .await,
            Err(ApiError::Forbidden(_))
        ));
        let scoped = Principal {
            wallet: owner.clone(),
            scope: Some(
                json!({"version":1,"mandates":[payment.mandate],"tools":["get_payment"],"agents":{}}),
            ),
        };
        assert!(
            matches!(call(scoped).await, Err(ApiError::Forbidden(message)) if message.contains("Owner session"))
        );

        // A receipt with no kept request is simply not found.
        let missing = get_receipt_request(
            State(state.clone()),
            Extension(owner_session),
            Path(key(13)),
        )
        .await;
        assert!(matches!(missing, Err(ApiError::NotFound)));
        task.abort();
    }

    #[tokio::test]
    async fn finalized_original_receipt_keeps_a_relay_observed_policy() {
        let mut state = state();
        let owner = key(11);
        let payment = submission(signed_request("Two widgets"));
        let receipt = payment.receipt_address.clone().unwrap();
        let chain = Chain {
            context_slot: 45,
            ..Chain::default()
        };
        chain.put(&payment.mandate, mandate_for(&owner, 40));
        chain.put(&receipt, receipt_for(&payment));
        let task = chain.clone().serve(&mut state).await;

        verify_finalized_receipt(&state, &record_for(&payment))
            .await
            .unwrap();
        let observed = state
            .store
            .find_observed_policy("devnet", DEFAULT_PROGRAM_ID, &receipt)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed.observed_at_slot, 45);
        assert!(!observed.includes_later_payments);
        assert_eq!(observed.limits.amount_spent_after, 4_500_000);
        assert_eq!(observed.limits.expires_at_slot, u64::MAX);
        let mandate_read = chain
            .requests
            .lock()
            .unwrap()
            .iter()
            .find(|params| {
                params[0] == payment.mandate.as_str() && !params[1]["minContextSlot"].is_null()
            })
            .cloned()
            .unwrap();
        assert_eq!(
            mandate_read[1]["minContextSlot"], 40,
            "read no earlier than the payment slot"
        );

        // The first observation is kept; a later read with more payments counted
        // never replaces it.
        chain.put(&payment.mandate, mandate_for(&owner, 44));
        state
            .store
            .put_observed_policy(ObservedPolicyRecord {
                includes_later_payments: true,
                observed_at_slot: 99,
                ..observed.clone()
            })
            .await
            .unwrap();
        assert_eq!(
            state
                .store
                .find_observed_policy("devnet", DEFAULT_PROGRAM_ID, &receipt)
                .await
                .unwrap()
                .unwrap(),
            observed
        );

        let Json(body) = get_receipt(
            State(state.clone()),
            Extension(Principal {
                wallet: owner.clone(),
                scope: None,
            }),
            Path(receipt.clone()),
        )
        .await
        .unwrap();
        assert_eq!(body["policy"]["source"], "relay-observed");
        assert_eq!(body["policy"]["observed_at_slot"], "45");
        assert_eq!(body["policy"]["total_limit"], "50000000");
        assert_eq!(body["mandate"], payment.mandate);
        task.abort();
    }

    #[tokio::test]
    async fn snapshot_receipts_are_never_relay_observed() {
        let mut state = state();
        let owner = key(11);
        let payment = submission(signed_request("Two widgets"));
        let receipt = payment.receipt_address.clone().unwrap();
        let chain = Chain {
            context_slot: 45,
            ..Chain::default()
        };
        chain.put(&payment.mandate, mandate_for(&owner, 40));
        chain.put(&receipt, with_snapshot(receipt_for(&payment)));
        let task = chain.clone().serve(&mut state).await;

        verify_finalized_receipt(&state, &record_for(&payment))
            .await
            .unwrap();
        assert!(
            state
                .store
                .find_observed_policy("devnet", DEFAULT_PROGRAM_ID, &receipt)
                .await
                .unwrap()
                .is_none()
        );
        let Json(body) = get_receipt(
            State(state.clone()),
            Extension(Principal {
                wallet: owner,
                scope: None,
            }),
            Path(receipt),
        )
        .await
        .unwrap();
        assert_eq!(body["policy"]["source"], "on-chain");
        assert_eq!(body["policy"]["snapshot_version"], 1);
        assert_eq!(body["policy"]["amount_spent_after"], "4500000");
        task.abort();
    }

    #[test]
    fn settlement_verification_accepts_both_receipt_sizes() {
        let payment = submission(signed_request("Two widgets"));
        let record = record_for(&payment);
        for data in [receipt_for(&payment), with_snapshot(receipt_for(&payment))] {
            let account = RpcAccount {
                owner: DEFAULT_PROGRAM_ID.into(),
                data,
            };
            verify_receipt_account(&account, &record, DEFAULT_PROGRAM_ID).unwrap();
        }
        let truncated = RpcAccount {
            owner: DEFAULT_PROGRAM_ID.into(),
            data: receipt_for(&payment)[..281].to_vec(),
        };
        assert!(verify_receipt_account(&truncated, &record, DEFAULT_PROGRAM_ID).is_err());
    }

    #[tokio::test]
    async fn existing_receipt_is_refused_as_duplicate_before_broadcast() {
        let (_, request, _) = transactions::tests::fixture(0);
        let mut state = state();
        let receipt = request.receipt_address.clone().unwrap();
        let chain = Chain::default();
        let mut mandate = mandate_for(&key(11), 0);
        mandate[40..72].copy_from_slice(
            &bs58::decode(request.agent.as_ref().unwrap())
                .into_vec()
                .unwrap(),
        );
        chain.put(&request.mandate, mandate);
        let task = chain.clone().serve(&mut state).await;

        // No receipt yet: the live check passes.
        validate_live_payment(&state, &request).await.unwrap();

        chain.put(&receipt, vec![0; RECEIPT_ACCOUNT_LENGTH]);
        assert!(matches!(
            validate_live_payment(&state, &request).await,
            Err(ApiError::DuplicateInvoice { receipt_address }) if receipt_address == receipt
        ));
        let mut record = recovery::initial(&request, SigningMode::Human).unwrap();
        record.signature = Some(recovery::signature(&request.signed_transaction).unwrap());
        assert!(matches!(
            settle_payment(&state, request.clone(), record).await,
            Err(ApiError::DuplicateInvoice { .. })
        ));

        let response = ApiError::DuplicateInvoice {
            receipt_address: receipt.clone(),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["code"], "DuplicateInvoice");
        assert_eq!(body["error"], DUPLICATE_INVOICE_MESSAGE);
        assert_eq!(body["receipt_address"], receipt);
        task.abort();
    }

    #[test]
    fn simulation_already_in_use_on_the_receipt_reads_as_duplicate() {
        let payment = submission(signed_request("Two widgets"));
        let receipt = payment.receipt_address.clone().unwrap();
        let record = record_for(&payment);
        let simulation = |address: &str| RpcError::Remote {
            method: "sendTransaction".into(),
            code: -32002,
            message: format!(
                "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x0 [-32002] ({{\"logs\":[\"Allocate: account Address {{ address: {address}, base: None }} already in use\"]}})"
            ),
        };
        let duplicate = recovery::payment_error(record.clone(), &simulation(&receipt));
        assert_eq!(duplicate.status, PaymentStatus::Failed);
        assert_eq!(duplicate.error.as_deref(), Some(DUPLICATE_INVOICE_MESSAGE));
        let unrelated = recovery::payment_error(record, &simulation(&key(99)));
        assert_ne!(unrelated.error.as_deref(), Some(DUPLICATE_INVOICE_MESSAGE));
    }

    #[tokio::test]
    async fn rpc_proxy_lists_both_receipt_sizes_only_with_a_mandate_filter() {
        let mut state = state();
        let task = Chain::default().serve(&mut state).await;
        let query = |filters: Value| {
            proxy_rpc(
                State(state.clone()),
                Json(JsonRpcProxyRequest {
                    jsonrpc: "2.0".into(),
                    id: json!(1),
                    method: "getProgramAccounts".into(),
                    params: Some(json!([DEFAULT_PROGRAM_ID, { "filters": filters }])),
                }),
            )
        };
        let mandate = json!({ "memcmp": { "offset": 8, "bytes": key(2) } });
        for size in [282, 371] {
            assert!(
                query(json!([{ "dataSize": size }, mandate])).await.is_ok(),
                "{size}"
            );
            assert!(matches!(
                query(json!([{ "dataSize": size }])).await,
                Err(ApiError::BadRequest(_))
            ));
        }
        assert!(matches!(
            query(json!([{ "dataSize": 372 }, mandate])).await,
            Err(ApiError::BadRequest(_))
        ));
        task.abort();
    }

    #[tokio::test]
    async fn memory_receipt_context_is_written_once() {
        written_once(StatusStore::in_memory()).await;
    }

    #[tokio::test]
    #[ignore = "requires isolated TEST_DATABASE_URL"]
    async fn postgres_receipt_context_is_written_once_and_survives_reconnect() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap();
        assert!(url.starts_with("postgresql://chainpay_test@127.0.0.1:55439/"));
        let store = StatusStore::connect(&url).await.unwrap();
        let (request, observed) = written_once(store).await;
        let reconnected = StatusStore::connect(&url).await.unwrap();
        assert_eq!(
            reconnected
                .find_receipt_request("devnet", DEFAULT_PROGRAM_ID, &request.receipt_address)
                .await
                .unwrap(),
            Some(request)
        );
        assert_eq!(
            reconnected
                .find_observed_policy("devnet", DEFAULT_PROGRAM_ID, &observed.receipt_address)
                .await
                .unwrap(),
            Some(observed)
        );
    }

    async fn written_once(store: StatusStore) -> (ReceiptRequestRecord, ObservedPolicyRecord) {
        let config = BackendConfig::from_env().unwrap();
        // Unique per run so a reused database never collides.
        let mut payment = submission(signed_request(&format!("Run {}", random_hex_32().unwrap())));
        let invoice = invoice_hash(payment.payment_request.as_ref().unwrap());
        payment.receipt_address = Some(receipt_address(&key(2), &invoice));
        let first = receipt_request_record(&config, &payment).unwrap().unwrap();
        assert_eq!(
            store.put_receipt_request(first.clone()).await.unwrap(),
            first
        );
        let mut later = first.clone();
        later.stored_at_ms += 1;
        later.signature = "different".into();
        assert_eq!(store.put_receipt_request(later).await.unwrap(), first);

        let observed = ObservedPolicyRecord {
            cluster: "devnet".into(),
            program_id: DEFAULT_PROGRAM_ID.into(),
            receipt_address: first.receipt_address.clone(),
            mandate: first.mandate.clone(),
            limits: ReceiptPolicyLimits {
                max_per_payment: u64::MAX,
                total_limit: 50,
                amount_spent_after: 12,
                payment_count_after: 3,
                max_payment_count: 0,
                expires_at_slot: u64::MAX,
                cooldown_slots: 0,
            },
            observed_at_slot: 45,
            includes_later_payments: false,
            observed_at_ms: 1,
        };
        assert_eq!(
            store.put_observed_policy(observed.clone()).await.unwrap(),
            observed
        );
        let mut replay = observed.clone();
        replay.observed_at_slot = 46;
        replay.includes_later_payments = true;
        assert_eq!(store.put_observed_policy(replay).await.unwrap(), observed);
        (first, observed)
    }
}
